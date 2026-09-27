#!/usr/bin/env python3
"""Talk to the SmartClass ESP32 over USB without opening a serial monitor.

  python3 firmware/esp32ctl.py range out        # simulate walking out (beacon off, reports suppressed)
  python3 firmware/esp32ctl.py range in         # back in range
  python3 firmware/esp32ctl.py stats            # counters, beacon + range state
  python3 firmware/esp32ctl.py beacon 317 1     # which room this board is
  python3 firmware/esp32ctl.py wifi MyHotspot pw123 ; python3 firmware/esp32ctl.py save
  python3 firmware/esp32ctl.py --port /dev/cu.usbserial-10 show

Needs pyserial:  pip3 install pyserial   (or run via:  uv run --with pyserial python3 firmware/esp32ctl.py ...)
"""
import glob, sys, time

try:
    import serial  # type: ignore
except ImportError:
    sys.exit("pyserial missing: pip3 install pyserial  (or: uv run --with pyserial python3 firmware/esp32ctl.py ...)")

args = sys.argv[1:]
port = None
if args[:1] == ["--port"]:
    port, args = args[1], args[2:]
if not args:
    sys.exit(__doc__)
if port is None:
    ports = sorted(glob.glob("/dev/cu.usbserial*") + glob.glob("/dev/cu.wchusbserial*") + glob.glob("/dev/cu.SLAB*") + glob.glob("/dev/ttyUSB*"))
    if not ports:
        sys.exit("no ESP32 serial port found (is it plugged in?)")
    port = ports[0]

last_err = None
for attempt in range(6):  # the port may still be held by a previous command for a moment
    try:
        with serial.Serial(port, 115200, timeout=1) as s:
            time.sleep(0.3)
            s.reset_input_buffer()
            s.write((" ".join(args) + "\n").encode())
            out = b""
            deadline = time.time() + 3.0
            while time.time() < deadline:
                chunk = s.read(4096)
                if chunk:
                    out += chunk
                elif out:
                    break
        break
    except (serial.SerialException, OSError) as e:
        last_err = e
        time.sleep(0.5)
else:
    sys.exit(f"could not open {port}: {last_err}")
lines = [l for l in out.decode("utf-8", "replace").splitlines() if l.strip() and not l.startswith("[stat]")]
print("\n".join(lines) if lines else "(no reply)")
