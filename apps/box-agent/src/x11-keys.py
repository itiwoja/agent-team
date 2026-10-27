"""固定DISPLAYのキー押下状態だけを保存/復旧する。入力文字やコマンドは受け取らない。"""

import ctypes as c
import sys


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("snapshot", "restore"):
        raise RuntimeError("invalid mode")
    target = None
    if sys.argv[1] == "restore":
        target = sys.stdin.buffer.read(33)
        if len(target) != 32 or target[0] != 0:
            raise RuntimeError("invalid key state")

    x = c.CDLL("libX11.so.6")
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = c.c_void_p
    x.XCloseDisplay.argtypes = [c.c_void_p]
    x.XQueryKeymap.argtypes = [c.c_void_p, c.c_void_p]
    x.XSync.argtypes = [c.c_void_p, c.c_int]
    handler_type = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_void_p)
    x.XSetErrorHandler.argtypes = [handler_type]
    x.XSetErrorHandler.restype = c.c_void_p
    had_error = False

    @handler_type
    def on_error(_display, _event):
        nonlocal had_error
        had_error = True
        return 0

    x.XSetErrorHandler(on_error)
    display = x.XOpenDisplay(b":99")
    if not display:
        raise RuntimeError("display unavailable")
    try:
        def query():
            state = (c.c_ubyte * 32)()
            if not x.XQueryKeymap(display, state) or had_error:
                raise RuntimeError("key query failed")
            return bytes(state)

        current = query()
        if target is None:
            sys.stdout.buffer.write(current)
            return

        xtest = c.CDLL("libXtst.so.6")
        xtest.XTestQueryExtension.argtypes = [c.c_void_p] + [c.POINTER(c.c_int)] * 4
        xtest.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
        info = [c.c_int() for _ in range(4)]
        if not xtest.XTestQueryExtension(display, *(c.byref(value) for value in info)):
            raise RuntimeError("XTEST unavailable")

        # type開始前から押されていたキーは維持する。マウスの状態には触れない。
        # 復旧中の外部入力で状態が変われば、下の再照合で失敗として通知する。
        for pressed in (False, True):
            for key in range(8, 256):
                was_down = bool(current[key // 8] & (1 << (key % 8)))
                should_down = bool(target[key // 8] & (1 << (key % 8)))
                if was_down != should_down and should_down == pressed:
                    if not xtest.XTestFakeKeyEvent(display, key, int(pressed), 0):
                        raise RuntimeError("key restore failed")
        x.XSync(display, 0)
        if query() != target or had_error:
            raise RuntimeError("key restore unverified")
    finally:
        x.XCloseDisplay(display)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Xの詳細や入力状態をstderrへ出さない。親は固定エラーとして扱う。
        sys.stderr.write("X_KEY_STATE_FAILED\n")
        sys.exit(1)
