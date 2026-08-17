"""USB 4x4 keypad OTP input via evdev (spec §7 keypad.py).

The keypad presents as a HID keyboard. Digits buffer; `#` submits, `*` clears.
On submit the callback fires with the 4-digit OTP buffer (empty string = clear).
"""

from __future__ import annotations

import logging
import threading

from evdev import InputDevice, categorize, ecodes, list_devices

log = logging.getLogger("kiosk.keypad")

KEY_DIGITS = {
    ecodes.KEY_0: "0", ecodes.KEY_1: "1", ecodes.KEY_2: "2", ecodes.KEY_3: "3",
    ecodes.KEY_4: "4", ecodes.KEY_5: "5", ecodes.KEY_6: "6", ecodes.KEY_7: "7",
    ecodes.KEY_8: "8", ecodes.KEY_9: "9", ecodes.KEY_KP0: "0", ecodes.KEY_KP1: "1",
    ecodes.KEY_KP2: "2", ecodes.KEY_KP3: "3", ecodes.KEY_KP4: "4", ecodes.KEY_KP5: "5",
    ecodes.KEY_KP6: "6", ecodes.KEY_KP7: "7", ecodes.KEY_KP8: "8", ecodes.KEY_KP9: "9",
}


def find_keypad_device(name_hint: str = "keypad") -> InputDevice | None:
    """Pick the HID device that looks like the 4x4 keypad."""
    for path in list_devices():
        try:
            dev = InputDevice(path)
            caps = dev.capabilities().get(ecodes.EV_KEY, [])
            has_digits = all(k in caps for k in (ecodes.KEY_0, ecodes.KEY_9, ecodes.KEY_KP1))
            if has_digits and name_hint in dev.name.lower():
                return dev
            if has_digits and "keyboard" not in dev.name.lower():
                return dev
        except OSError:
            continue
    return None


class KeypadListener:
    """Runs a thread reading key events; calls on_submit(otp) on '#'."""

    def __init__(self, on_submit, on_change=None):
        self.on_submit = on_submit
        self.on_change = on_change  # buffer preview for the display
        self.buffer = ""
        self._stop = threading.Event()

    def start(self) -> bool:
        dev = find_keypad_device()
        if dev is None:
            log.error("keypad device not found — OTP entry unavailable")
            return False
        threading.Thread(target=self._loop, args=(dev,), daemon=True, name="keypad").start()
        return True

    def stop(self) -> None:
        self._stop.set()

    def _loop(self, dev: InputDevice) -> None:
        log.info("keypad listening on %s (%s)", dev.path, dev.name)
        try:
            for event in dev.read_loop():
                if self._stop.is_set():
                    break
                if event.type != ecodes.EV_KEY:
                    continue
                key = categorize(event)
                if key.keystate != key.key_down:
                    continue
                code = key.eventcode
                if code in KEY_DIGITS:
                    if len(self.buffer) < 4:
                        self.buffer += KEY_DIGITS[code]
                        self._notify()
                elif code == ecodes.KEY_KPENTER or code == ecodes.KEY_ENTER:  # '#'-mapped or Enter
                    submitted, self.buffer = self.buffer, ""
                    self._notify()
                    if submitted:
                        self.on_submit(submitted)
                elif code == ecodes.KEY_ESC or code == ecodes.KEY_BACKSPACE:  # '*'-mapped
                    self.buffer = ""
                    self._notify()
        except OSError:
            log.error("keypad device lost", exc_info=True)

    def _notify(self) -> None:
        if self.on_change:
            try:
                self.on_change(self.buffer)
            except Exception:  # noqa: BLE001
                pass
