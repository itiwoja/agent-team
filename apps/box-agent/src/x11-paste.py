"""UTF-8本文をstdinから受ける、一時的なX11 CLIPBOARD所有者。

既存のCLIPBOARDは置き換える。転送後は所有権を解放し、本文を保持する常駐役は残さない。
"""

import ctypes as c
import select
import sys
import time


class Request(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", c.c_void_p), ("owner", c.c_ulong), ("requestor", c.c_ulong),
                ("selection", c.c_ulong), ("target", c.c_ulong), ("property", c.c_ulong), ("time", c.c_ulong)]


class Notify(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", c.c_void_p), ("requestor", c.c_ulong), ("selection", c.c_ulong),
                ("target", c.c_ulong), ("property", c.c_ulong), ("time", c.c_ulong)]


class Property(c.Structure):
    _fields_ = [("type", c.c_int), ("serial", c.c_ulong), ("send_event", c.c_int),
                ("display", c.c_void_p), ("window", c.c_ulong), ("atom", c.c_ulong),
                ("time", c.c_ulong), ("state", c.c_int)]


class Event(c.Union):
    _fields_ = [("type", c.c_int), ("request", Request), ("notify", Notify),
                ("property", Property), ("pad", c.c_long * 24)]


def main():
    if len(sys.argv) != 1:
        raise RuntimeError("invalid arguments")
    text = sys.stdin.buffer.read(16_001)
    if len(text) > 16_000 or b"\0" in text:
        raise RuntimeError("invalid text")
    text.decode("utf-8", errors="strict")
    x = c.CDLL("libX11.so.6")
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = c.c_void_p
    x.XDefaultRootWindow.argtypes = [c.c_void_p]
    x.XDefaultRootWindow.restype = c.c_ulong
    x.XCreateSimpleWindow.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_uint, c.c_ulong, c.c_ulong]
    x.XCreateSimpleWindow.restype = c.c_ulong
    x.XInternAtom.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
    x.XInternAtom.restype = c.c_ulong
    x.XSetSelectionOwner.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_ulong]
    x.XGetSelectionOwner.argtypes = [c.c_void_p, c.c_ulong]
    x.XGetSelectionOwner.restype = c.c_ulong
    x.XSelectInput.argtypes = [c.c_void_p, c.c_ulong, c.c_long]
    x.XChangeProperty.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_ulong, c.c_int, c.c_int, c.c_void_p, c.c_int]
    x.XSendEvent.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_long, c.POINTER(Event)]
    x.XPending.argtypes = [c.c_void_p]
    x.XNextEvent.argtypes = [c.c_void_p, c.POINTER(Event)]
    x.XConnectionNumber.argtypes = [c.c_void_p]
    x.XFlush.argtypes = [c.c_void_p]
    x.XDestroyWindow.argtypes = [c.c_void_p, c.c_ulong]
    x.XCloseDisplay.argtypes = [c.c_void_p]
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
    window = 0
    clipboard = 0
    try:
        window = x.XCreateSimpleWindow(display, x.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
        clipboard = x.XInternAtom(display, b"CLIPBOARD", 0)
        targets = x.XInternAtom(display, b"TARGETS", 0)
        formats = [x.XInternAtom(display, name, 0) for name in (b"UTF8_STRING", b"text/plain;charset=utf-8", b"text/plain")]
        offered = (c.c_ulong * 4)(targets, *formats)
        x.XSetSelectionOwner(display, clipboard, window, 0)
        if x.XGetSelectionOwner(display, clipboard) != window or had_error:
            raise RuntimeError("selection unavailable")
        print("READY", flush=True)
        deadline = time.monotonic() + 9
        consumed_at = None
        pending = set()
        requests = 0
        while time.monotonic() < deadline:
            while x.XPending(display):
                event = Event()
                x.XNextEvent(display, c.byref(event))
                if event.type == 29:  # SelectionClear: 他者が所有権を取得した。
                    raise RuntimeError("selection replaced")
                if event.type == 30:  # SelectionRequest
                    requests += 1
                    if requests > 64:
                        raise RuntimeError("too many selection requests")
                    request = event.request
                    prop = request.property or request.target
                    accepted = request.selection == clipboard and request.target in [targets, *formats]
                    if accepted:
                        if request.target == targets:
                            x.XChangeProperty(display, request.requestor, prop, 4, 32, 0, offered, len(offered))
                        else:
                            x.XSelectInput(display, request.requestor, 1 << 22)
                            pending.add((request.requestor, prop))
                            consumed_at = None
                            x.XChangeProperty(display, request.requestor, prop, request.target, 8, 0, text, len(text))
                    reply = Event()
                    reply.notify = Notify(31, 0, 0, display, request.requestor, request.selection,
                                          request.target, prop if accepted else 0, request.time)
                    x.XSendEvent(display, request.requestor, 0, 0, c.byref(reply))
                    x.XFlush(display)
                elif event.type == 28 and event.property.state == 1:  # PropertyDelete: 受信側が本文を取り出した。
                    key = (event.property.window, event.property.atom)
                    if key in pending:
                        pending.remove(key)
                        consumed_at = time.monotonic()
            if had_error:
                raise RuntimeError("selection transfer failed")
            # 複数の受信形式の問い合わせを処理してから、本文を保持せず終了する。
            if consumed_at is not None and not pending and time.monotonic() - consumed_at >= 0.3:
                print("PASTED", flush=True)
                return
            select.select([x.XConnectionNumber(display)], [], [], 0.05)
        raise RuntimeError("selection timeout")
    finally:
        if window:
            if clipboard and x.XGetSelectionOwner(display, clipboard) == window:
                x.XSetSelectionOwner(display, clipboard, 0, 0)
            x.XDestroyWindow(display, window)
        x.XCloseDisplay(display)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("X_PASTE_FAILED\n")
        sys.exit(1)
