// web_fetch の取得の守り：ドメインの型・内部のアドレスの拒否・URL の確かめ・HTML を文字にする
import { describe, expect, it } from "vitest";
import { WebFetchError, checkUrl, domainMatches, hostAllowed, htmlToText, isBlockedIp, titleOf, transitResponseIsRedirect } from "./web-page.ts";

const ALL = { allow: ["*"], deny: ["*.internal", "localhost"] };

function codeOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof WebFetchError ? e.code : "other";
  }
}

describe("domainMatches・hostAllowed", () => {
  it("* はすべて、*.x は下のホストだけ、x はそのホストと下のホスト", () => {
    expect(domainMatches("www.example.com", "*")).toBe(true);
    expect(domainMatches("a.example.com", "*.example.com")).toBe(true);
    expect(domainMatches("example.com", "*.example.com")).toBe(false);
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("docs.example.com", "example.com")).toBe(true);
    expect(domainMatches("badexample.com", "example.com")).toBe(false);
    expect(domainMatches("EXAMPLE.com.", "example.com")).toBe(true);
  });
  it("拒否が付与に勝つ", () => {
    expect(hostAllowed("metadata.google.internal", ALL)).toBe(false);
    expect(hostAllowed("localhost", ALL)).toBe(false);
    expect(hostAllowed("www.anthropic.com", ALL)).toBe(true);
    expect(hostAllowed("www.anthropic.com", { allow: ["example.com"], deny: [] })).toBe(false);
  });
});

describe("isBlockedIp", () => {
  it("プライベート・ループバック・リンクローカル（メタデータサーバー）・IPv4 を写した IPv6 を拒む", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "not-an-ip"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("公開のアドレスは通す", () => {
    for (const ip of ["8.8.8.8", "142.250.196.110", "2001:4860:4860::8888"]) expect(isBlockedIp(ip), ip).toBe(false);
  });
});

describe("checkUrl", () => {
  it("http・https の既定のポートで、付与されたドメインだけ", () => {
    expect(checkUrl("https://www.anthropic.com/news", ALL).hostname).toBe("www.anthropic.com");
    expect(codeOf(() => checkUrl("file:///etc/passwd", ALL))).toBe("WEB_INVALID_URL");
    expect(codeOf(() => checkUrl("ftp://example.com/", ALL))).toBe("WEB_INVALID_URL");
    expect(codeOf(() => checkUrl("https://user:pw@example.com/", ALL))).toBe("WEB_INVALID_URL");
    expect(codeOf(() => checkUrl("http://example.com:8080/", ALL))).toBe("WEB_INVALID_URL");
    expect(codeOf(() => checkUrl("not a url", ALL))).toBe("WEB_INVALID_URL");
    expect(codeOf(() => checkUrl("http://metadata.google.internal/", ALL))).toBe("WEB_DOMAIN_NOT_ALLOWED");
    expect(codeOf(() => checkUrl("https://example.org/", { allow: ["example.com"], deny: [] }))).toBe("WEB_DOMAIN_NOT_ALLOWED");
  });
  it("IP の直書きは内部のアドレスなら拒む", () => {
    expect(codeOf(() => checkUrl("http://169.254.169.254/computeMetadata/v1/", ALL))).toBe("WEB_BLOCKED_ADDRESS");
    expect(codeOf(() => checkUrl("http://[::1]/", ALL))).toBe("WEB_BLOCKED_ADDRESS");
    expect(codeOf(() => checkUrl("http://127.1/", ALL))).toBe("WEB_BLOCKED_ADDRESS");
  });
});

describe("htmlToText", () => {
  it("script・style を除き、ブロックの区切りを改行にし、文字参照を戻す", () => {
    const html =
      "<html><head><title>t</title><style>p{}</style></head><body><script>alert(1)</script>" +
      "<h1>Claude Opus 5.5</h1><p>価格は&nbsp;$5 &amp; 速い</p><ul><li>A</li><li>B&#x3042;</li></ul></body></html>";
    expect(htmlToText(html)).toBe("Claude Opus 5.5\n価格は $5 & 速い\nA\nBあ");
  });
});

describe("htmlToText・titleOf の計算量（病的な入力でも長く止まらない）", () => {
  const cases: Array<[string, string]> = [
    ["閉じていない <", "<".repeat(2_000_000)],
    ["閉じていない注釈", "<!--".repeat(500_000)],
    ["閉じていない script", "<script".repeat(300_000)],
    ["閉じていない title", "<title".repeat(300_000)],
    ["閉じていない <p", "<p".repeat(1_000_000)],
    ["閉じていない &", "&a".repeat(1_000_000)],
  ];
  for (const [name, html] of cases) {
    it(`${name} は 200ms 未満で終わる`, () => {
      const t0 = performance.now();
      htmlToText(html);
      titleOf(html);
      expect(performance.now() - t0).toBeLessThan(200);
    });
  }
  it("512KB を超えた分は読まない（出力も上限まで）", () => {
    const text = htmlToText("a".repeat(600 * 1024));
    expect(text.length).toBeLessThanOrEqual(512 * 1024);
  });
});

describe("htmlToText の細かい挙動", () => {
  it("閉じていない注釈は、その先を捨てる。閉じていない < と <> は文字のまま", () => {
    expect(htmlToText("前<!-- 途中で切れる 後")).toBe("前");
    expect(htmlToText("a < b")).toBe("a < b");
    expect(htmlToText("x<>y")).toBe("x<>y");
    expect(htmlToText("<!-- x --><p>本文</p>")).toBe("本文");
  });
  it("閉じていない script・style は、その先を捨てる", () => {
    expect(htmlToText("前<script>alert(1)")).toBe("前");
  });
  it("別の名前のタグ（header・scripts）は script・head として扱わない", () => {
    expect(htmlToText("<header>見出し</header><scripts>残る</scripts>")).toBe("見出し\n残る");
    expect(htmlToText("<script-widget>表示される本文</script-widget><p>後</p>")).toBe("表示される本文\n後");
  });
  it("属性値の引用符内の > はタグ終端にしない", () => {
    expect(htmlToText('<p data-x="a > b">本文</p>')).toBe("本文");
  });
});

describe("titleOf", () => {
  it("題名を取り、空白を整え、文字参照を戻す。閉じがなければ null", () => {
    expect(titleOf("<html><title>  お知らせ &amp;\n 一覧 </title></html>")).toBe("お知らせ & 一覧");
    expect(titleOf('<title data-x="a > b">題名</title>')).toBe("題名");
    expect(titleOf("<title>   </title>")).toBeNull();
    expect(titleOf("<title>閉じていない")).toBeNull();
    expect(titleOf("本文だけ")).toBeNull();
  });
});

describe("IPv6 の埋め込みアドレス", () => {
  it("IPv4 互換（::/96）・6to4（2002::/16）は、埋め込みの IPv4 で判定する", () => {
    for (const ip of ["::127.0.0.1", "::7f00:1", "::10.0.0.1", "::169.254.169.254", "2002:7f00:1::", "2002:c000:204::1", "2002:a9fe:a9fe::"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["2002:0808:0808::", "::0808:0808"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
  it("NAT64（64:ff9b::/96・64:ff9b:1::/48）は拒む", () => {
    for (const ip of ["64:ff9b::808:808", "64:ff9b::7f00:1", "64:ff9b:1::1", "64:ff9b:1:ffff::8"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
  it("IPv4 互換でも6to4でもない普通の IPv6 は、従来どおり拒否リストで見る", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
  });
});

describe("checkUrl：Grounding の転送用ホスト", () => {
  const LIMITED = { allow: ["anthropic.com"], deny: [] };
  const TRANSIT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123";

  it("最初の1歩（allowTransit）だけ、付与にかかわらず転送用ホストを通す", () => {
    expect(checkUrl(TRANSIT, LIMITED, true).hostname).toBe("vertexaisearch.cloud.google.com");
  });
  it("明示的な拒否は allowTransit でも優先する", () => {
    expect(codeOf(() => checkUrl(TRANSIT, { allow: ["*"], deny: ["vertexaisearch.cloud.google.com"] }, true))).toBe("WEB_DOMAIN_NOT_ALLOWED");
  });
  it("転送用ホストでも、最初の1歩でなければ付与で確かめる（転送先の再確認を含む）", () => {
    expect(codeOf(() => checkUrl(TRANSIT, LIMITED))).toBe("WEB_DOMAIN_NOT_ALLOWED");
  });
  it("転送用ホスト以外は、最初の1歩でも付与で確かめる", () => {
    expect(codeOf(() => checkUrl("https://evil.example/", LIMITED, true))).toBe("WEB_DOMAIN_NOT_ALLOWED");
    expect(codeOf(() => checkUrl("https://vertexaisearch.cloud.google.com.evil.example/", LIMITED, true))).toBe("WEB_DOMAIN_NOT_ALLOWED");
  });
});

describe("fetchPage：転送用ホスト", () => {
  it("転送ではない成功応答（任意 URL の 200 本文）は許可対象にしない", () => {
    const transit = new URL("https://vertexaisearch.cloud.google.com/arbitrary?x=1");
    expect(transitResponseIsRedirect(transit, 200, undefined)).toBe(false);
    expect(transitResponseIsRedirect(transit, 302, "https://anthropic.com/page")).toBe(true);
    expect(transitResponseIsRedirect(new URL("https://anthropic.com/page"), 200, undefined)).toBe(true);
  });
});
