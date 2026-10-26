# Chromium 用 seccomp の出典・差分・検証

対象: [`makase-browser-seccomp.json`](./makase-browser-seccomp.json)。ステップ 1.1 の非 root Chromium 用。`--cap-drop ALL`・`--security-opt no-new-privileges`・読み取り専用ルートと組み合わせる。`--privileged`、`--cap-add SYS_ADMIN`、`seccomp=unconfined`、`--no-sandbox` は使用しない。

## 固定した上流

2026-10-26 に公開一次情報から取得した。古い Playwright 同梱 JSON や推測の syscall 一覧ではなく、**Docker Engine 29.8.1 が依存する Moby の既定プロファイル**を土台にした。

| 項目 | 固定値・根拠 |
|---|---|
| Docker のタグ | [`moby/moby` の `docker-v29.8.1`](https://github.com/moby/moby/tree/docker-v29.8.1)（`v29.8.1` ではない） |
| Docker の commit | `464cd50c3d9e92877d56940ea160de6fca7bea23` |
| 依存バージョン | [`go.mod`](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/go.mod) の `github.com/moby/profiles/seccomp v0.2.3` |
| 既定の読み込み | [`daemon/seccomp_linux.go`](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/daemon/seccomp_linux.go) の `seccomp.GetDefaultProfile`。カスタム JSON は `seccomp.LoadProfile` で読む |
| プロファイルの revision | [`moby/profiles` の `seccomp/v0.2.3`](https://github.com/moby/profiles/tree/seccomp/v0.2.3)、commit `836ae4d37ef2ec995c77c99fc55f5b5f3af3a897` |
| 取得元 URL | <https://raw.githubusercontent.com/moby/profiles/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/default.json> |
| 上流 JSON の SHA-256 | `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`（取得した 13,470 bytes、整形前） |
| 派生 JSON の SHA-256 | `27e6a36e9fdb4496abf8b2e09bf1ca3f305c64a003fbcac3c7d1fd6ba23e8237` |
| 上流ライセンス | Apache-2.0、Copyright The Moby Authors.。下に原文を同梱 |
| ライセンス URL | <https://raw.githubusercontent.com/moby/profiles/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/LICENSE> |
| LICENSE の SHA-256 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |

[`profiles` 側の `default_linux.go`](https://github.com/moby/profiles/blob/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/default_linux.go) と [Docker の vendor 内の同ファイル](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/vendor/github.com/moby/profiles/seccomp/default_linux.go) の本文一致も確認した。上流 JSON は [`generate.go`](https://github.com/moby/profiles/blob/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/generate.go) が `DefaultProfile()` から生成するもの。上流に独立した `NOTICE` ファイルはない。

## 既定との差

**変更告知:** Moby の JSON を再整形し、末尾に以下の 5 規則だけを追加した。上流の 33 規則・`archMap`・`defaultAction: SCMP_ACT_ERRNO`・`defaultErrnoRet: 1`（EPERM）は変更していない。JSON 内の追加規則にも `comment` で変更を明示した。

追加規則はすべて `includes.arches: ["amd64", "arm64"]` と `SCMP_ACT_ALLOW`。引数番号は 0 始まり。

| syscall | 追加する条件 | 用途 |
|---|---|---|
| `clone` | 引数 0 の `(flags & 0x9fffffff) == 0x10000011`。`value=2684354559`、`valueTwo=268435473` | `CLONE_NEWUSER | SIGCHLD` を必須とし、`CLONE_NEWPID`・`CLONE_NEWNET` だけ任意追加できる。USER 以外の任意 namespace や他の clone フラグを一括許可しない |
| `clone` | 引数 0 が `0x20000011`（536870929）と等しい | zygote の子の `CLONE_NEWPID | SIGCHLD`。USER namespace 内で行う後段の隔離に必要 |
| `unshare` | 引数 0 が `CLONE_NEWUSER`（268435456）と等しい | 非特権 USER namespace の事前検査・移動。mount/NET/PID 等の unshare は追加しない |
| `setns` | 引数 1 が `CLONE_NEWUSER`（268435456）と等しい | Playwright の提案する許可を USER 型だけに絞った互換用。型 0（任意型）、別型、複数型は許可しない |
| `chroot` | 引数条件なし | Chromium が USER namespace 内で `/proc/self/fdinfo/` という空ディレクトリに閉じ込める処理。`--cap-drop ALL` では既定の `CAP_SYS_CHROOT` 条件が除外されるため、syscall の許可だけ追加する |

通常の fork/thread 用 `clone` は既存規則のまま。`clone3` は追加許可しない。`CAP_SYS_ADMIN` なしでは既定の `errnoRet: 38`（ENOSYS）が維持され、glibc が旧 `clone` にフォールバックできる。`clone3` の flags はポインタ先の構造体にあるため、旧 `clone` と同じ引数マスクをそのまま適用できない。

既定に含まれる `CAP_SYS_ADMIN` 等の条件付き規則は、capability を**与える**ものではない。Docker は起動時の bounding set で規則を選別するので、`--cap-drop ALL` のときは取り込まれない。プロセスが子 USER namespace 内で得る、その namespace に限定された capability と、コンテナ起動時のホスト側 capability の追加は別物である。

### 許可を絞った根拠と限界

- [Playwright 公式 Docker 手順](https://playwright.dev/docs/docker#crawling-and-scraping) は非 root ユーザーと、`clone`・`unshare`・`setns` の無条件許可を既定に追加する方法を示す。本ファイルはその**考え方だけ**を参考にし、古い既定 JSON、無条件 namespace 許可、`--ipc=host`、`--cap-add SYS_ADMIN` は採用しない。
- Chromium ソースの確認 revision: `4253f08d805f75964e703789f2639df3a98582ec`。
  - [`namespace_sandbox.cc`](https://github.com/chromium/chromium/blob/4253f08d805f75964e703789f2639df3a98582ec/sandbox/linux/services/namespace_sandbox.cc): `Options` は USER/PID/NET、`ForkInNewPidNamespace` は PID と SIGCHLD。
  - [`launch_posix.cc`](https://github.com/chromium/chromium/blob/4253f08d805f75964e703789f2639df3a98582ec/base/process/launch_posix.cc): `LaunchProcess` が namespace フラグに SIGCHLD を付け、`ForkWithFlags` で渡す。
  - [`credentials.cc`](https://github.com/chromium/chromium/blob/4253f08d805f75964e703789f2639df3a98582ec/sandbox/linux/services/credentials.cc): `CanCreateProcessInNewUserNS`・`MoveToNewUserNS` の `unshare(CLONE_NEWUSER)`、`ChrootToSafeEmptyDir` の `chroot`。
  - [`sandbox_linux.cc`](https://github.com/chromium/chromium/blob/4253f08d805f75964e703789f2639df3a98582ec/sandbox/policy/linux/sandbox_linux.cc): `EngageNamespaceSandboxInternal` が USER namespace に移動した後にファイルシステムへのアクセスを落とす。
- `setns` は上記起動経路で必須とは確認できていない。要求された 3 syscall のうち、この許可だけは Playwright 互換用の USER 型限定であり、実機トレースによる最小性の証明ではない。
- seccomp は引数の指す文字列や fd の中身を検査できない。したがって `chroot` を特定パス、`setns` を特定 namespace fd に限定したとは主張しない。カーネルの capability・namespace・LSM 検査は引き続き必要。USER namespace を開くことで増えるカーネル攻撃面も残る。
- これは上流ソースに基づく最小化候補であり、イメージ内の Debian Chromium の実行確認を代替しない。更新時は拒否ログ・実際の syscall を確認してから条件を見直し、無条件許可で回避しない。

## amd64 / arm64

両方の Linux ABI では旧 `clone` の flags は引数 0、`unshare` の flags は引数 0、`setns` の型は引数 1。上流も s390/s390x だけ旧 `clone` の flags を引数 1 にする規則を分けており、本追加規則はそれらのアーキテクチャに適用しない。`CLONE_NEWUSER=0x10000000`、`CLONE_NEWPID=0x20000000`、`CLONE_NEWNET=0x40000000`、`SIGCHLD=17` を使用する。

上流 `archMap` は X86_64（X86/X32 を含む）と AARCH64（ARM を含む）の両方を保持し、syscall 番号ではなく名前で記述している。[上流の `seccomp_linux.go`](https://github.com/moby/profiles/blob/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/seccomp_linux.go) がホストのネイティブ arch に応じて選ぶ。`includes.arches` は各 syscall の ABI を個別指定する構文ではないため、互換 ABI でも適用され得る。対象はネイティブの amd64/arm64 Chromium であり、他の arch や QEMU 経由での成功は保証しない。

## 静的検証

リポジトリルートから実行する。依存追加や Docker 起動は不要。

### 出典のハッシュと、上流を削っていないこと

この検査だけは公開 GitHub への読み取り通信を使う。

```sh
python3 - <<'PY'
import hashlib
import json
import urllib.request
from pathlib import Path
rev = '836ae4d37ef2ec995c77c99fc55f5b5f3af3a897'
url = f'https://raw.githubusercontent.com/moby/profiles/{rev}/seccomp/default.json'
with urllib.request.urlopen(url, timeout=30) as response:
    raw = response.read()
assert hashlib.sha256(raw).hexdigest() == '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74'
upstream = json.loads(raw)
local = json.loads(Path('docker/makase-browser-seccomp.json').read_text())
assert len(upstream['syscalls']) == 33
assert len(local['syscalls']) == 38
local['syscalls'] = local['syscalls'][:33]
assert local == upstream
print('PASS: 上流 SHA-256、JSON parse、上流 33 規則の維持、追加 5 規則')
PY
```

### 追加条件と拒否条件（オフライン）

これは JSON の静的な条件評価であり、libseccomp/カーネルでのロード試験ではない。capability 空・kernel 4.8 以上の前提で関連 syscall を評価する。

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync('docker/makase-browser-seccomp.json', 'utf8'));
assert.equal(p.defaultAction, 'SCMP_ACT_ERRNO');
assert.equal(p.defaultErrnoRet, 1);
const extra = p.syscalls.slice(33);
assert.deepEqual(extra.map(r => r.names), [['clone'], ['clone'], ['unshare'], ['setns'], ['chroot']]);
for (const r of extra) {
  assert.equal(r.action, 'SCMP_ACT_ALLOW');
  assert.deepEqual(r.includes, {arches: ['amd64', 'arm64']});
}
assert.deepEqual(extra.map(r => r.args ?? []), [
  [{index: 0, value: 2684354559, valueTwo: 268435473, op: 'SCMP_CMP_MASKED_EQ'}],
  [{index: 0, value: 536870929, op: 'SCMP_CMP_EQ'}],
  [{index: 0, value: 268435456, op: 'SCMP_CMP_EQ'}],
  [{index: 1, value: 268435456, op: 'SCMP_CMP_EQ'}],
  []
]);
const ns = [0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000];
const allowedNS = new Set([0x10000000, 0x30000000, 0x50000000, 0x70000000, 0x20000000]);
function result(arch, name, args = []) {
  const rules = p.syscalls.filter(r => r.names.includes(name)
    && !(r.includes?.caps?.length)
    && (!r.includes?.arches || r.includes.arches.includes(arch))
    && !r.excludes?.arches?.includes(arch));
  const hits = rules.filter(r => (r.args ?? []).every(a => {
    const n = BigInt(args[a.index] ?? 0), v = BigInt(a.value);
    switch (a.op) {
      case 'SCMP_CMP_EQ': return n === v;
      case 'SCMP_CMP_MASKED_EQ': return (n & v) === BigInt(a.valueTwo ?? 0);
      default: throw new Error(`この検査の対象外の演算子: ${a.op}`);
    }
  }));
  if (hits.some(r => r.action === 'SCMP_ACT_ERRNO'))
    return `errno:${hits.find(r => r.action === 'SCMP_ACT_ERRNO').errnoRet}`;
  return hits.some(r => r.action === 'SCMP_ACT_ALLOW') ? 'allow' : `errno:${p.defaultErrnoRet}`;
}
for (const arch of ['amd64', 'arm64', 'riscv64']) {
  const target = arch !== 'riscv64';
  for (let bits = 0; bits < 128; bits++) {
    const flags = ns.reduce((n, bit, i) => n | (bits & (1 << i) ? bit : 0), 0);
    for (const signal of [0, 9, 17]) {
      const expected = flags === 0 || (target && signal === 17 && allowedNS.has(flags));
      assert.equal(result(arch, 'clone', [flags | signal]), expected ? 'allow' : 'errno:1');
    }
    assert.equal(result(arch, 'unshare', [flags]), target && flags === 0x10000000 ? 'allow' : 'errno:1');
    assert.equal(result(arch, 'setns', [3, flags]), target && flags === 0x10000000 ? 'allow' : 'errno:1');
  }
  assert.equal(result(arch, 'clone', [0x10000211]), 'errno:1'); // USER + CLONE_FS を追加しない
  assert.equal(result(arch, 'clone3'), 'errno:38');
  assert.equal(result(arch, 'unshare', [0x10000080]), 'errno:1'); // USER + TIME を追加しない
  assert.equal(result(arch, 'chroot'), target ? 'allow' : 'errno:1');
  for (const name of ['mount', 'umount2', 'bpf', 'perf_event_open', 'keyctl', 'reboot'])
    assert.equal(result(arch, name), 'errno:1');
}
console.log('PASS: amd64/arm64 の許可・拒否、他 arch の非拡張、clone3 ENOSYS');
NODE
```

作成時の検査結果（2026-10-26）: 上記 2 検査は成功。同梱したライセンス原文の SHA-256 も上流と一致。上流取得の初回検査では Node の `fetch` に ETIMEDOUT が出たため、取得・比較の再検査は Python の `urllib.request` で行った。Docker/arm64 実機検査はこの結果に含まれない。

## Docker 統合検証への引き継ぎ

このファイルの作成担当は **Docker build/run を実行していない**。次は親担当が、同じイメージ・非 root ユーザー・全 capability 削除・no-new-privileges・読み取り専用ルート・書き込み可能なホームと `/tmp`・所定の資源上限で比較する。

1. `--security-opt seccomp=builtin`（Docker 29.8.1 の組み込み既定）で起動し、Chromium が namespace sandbox を作れず失敗することと stderr を保存する。daemon のカスタム既定がないなら seccomp オプションの省略でもよい。
2. `--security-opt seccomp=docker/makase-browser-seccomp.json` で起動し、sandbox 無効化フラグを使わず成功することを確認する。起動できただけで sandbox 有効とは扱わず、`chrome://sandbox` 等で namespace と Seccomp-BPF の有効性を記録する。
3. `docker inspect` の `CapDrop=["ALL"]`・`ReadonlyRootfs=true`・`SecurityOpt`、起動ユーザーを保存する。主プロセスの `/proc/<pid>/status` の `NoNewPrivs: 1`・`Seccomp: 2`・capability と、renderer の状態も確認する。`Seccomp: 2` だけでは Docker の外側フィルタと Chromium 自身のフィルタを区別できない。
4. 必要なら使い捨ての検証プログラムで `clone3` が ENOSYS を返し、禁止した namespace・`mount` が EPERM になることも確認する。これは静的検査の代替ではなく実装確認。
5. amd64 の成功を arm64 の実測と見なさない。arm64 はネイティブ Docker ホスト上で同じ比較を行う。カーネルの USER namespace 対応、`user.max_user_namespaces`、存在すれば `kernel.unprivileged_userns_clone`、AppArmor 等の LSM が許すことが別途必要。失敗したらホスト設定を変更せず、制約として記録する。

`seccomp=builtin` の値は [Docker の定数定義](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/daemon/config/config.go) と上記の読み込み処理に基づく。Docker/Chromium 更新時は上流の revision と差分を再確認する。本ファイルは自動で最新版に追従しない。

## 上流ライセンス原文

以下は Moby の `LICENSE` の原文。コードの由来と変更内容は上記のとおりであり、この部分は翻訳しない。

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
