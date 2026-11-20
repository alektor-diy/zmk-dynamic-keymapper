#!/usr/bin/env python3
"""Configure a ZDKM device over its dedicated USB serial port."""

import argparse
import json
import sys
import time


class ProtocolError(Exception):
    pass


class Device:
    def __init__(self, port):
        self.port = port
        self.port.reset_input_buffer()
        self.port.write(b"\nHELLO\n")
        # A leading newline can finish an incomplete frame left by a prior client.
        for _ in range(3):
            if self.read_line() == ["OK", "ZDKM", "1"]:
                break
        else:
            raise ProtocolError("port did not answer with ZDKM protocol version 1")

    def read_line(self):
        reply = self.port.read_until(size=161)
        if not reply:
            raise ProtocolError("no response from the port")
        if not reply.endswith(b"\n"):
            raise ProtocolError("incomplete response from the port")
        return reply.decode("utf-8", errors="replace").split()

    def request(self, request, expected, fields=0):
        self.port.write(f"{request}\n".encode("ascii"))
        reply = self.read_line()
        if reply[:2] != ["OK", expected] or (fields is not None and len(reply) != fields + 2):
            raise ProtocolError(f"{request} returned {' '.join(reply) or 'an empty response'}")
        return reply[2:]

    def info(self):
        positions, slots, timeout, status = self.request("INFO", "INFO", 4)
        return {
            "positions": int(positions),
            "slots": int(slots),
            "timeout_ms": int(timeout),
            "status": status,
        }

    def capabilities(self):
        self.port.write(b"CAPS\n")
        reply = self.read_line()
        if reply == ["ERR", "UNKNOWN"]:
            return None
        if reply[:2] != ["OK", "CAPS"] or len(reply) != 5:
            raise ProtocolError(f"CAPS returned {' '.join(reply)}")
        keys, layers, count = map(int, reply[2:])
        actions = {}
        for index in range(count):
            code, *label = self.request(f"ACTION {index}", "ACTION", None)
            actions[int(code)] = " ".join(label)
        return {"keys": keys, "layers": layers, "actions": actions}

    def combos(self, slots, advanced):
        combos = []
        for slot in range(slots):
            if advanced:
                fields = self.request(f"COMBO {slot}", "COMBO", None)
                if len(fields) < 6:
                    raise ProtocolError("incomplete COMBO response")
                output, timeout, idle, layers, slow, count, *positions = map(int, fields)
                if len(positions) != count:
                    raise ProtocolError("invalid COMBO key count")
                if count:
                    combos.append({"slot": slot, "positions": positions, "output": output,
                                   "timeout_ms": timeout, "prior_idle_ms": idle,
                                   "layer_mask": layers, "slow_release": bool(slow)})
                    if output < 256:
                        combos[-1]["usage"] = output
            else:
                first, second, usage = map(int, self.request(f"SLOT {slot}", "SLOT", 3))
                if usage:
                    combos.append({"slot": slot, "positions": [first, second], "usage": usage})
        return combos

    def layout(self, positions):
        fields = ("x", "y", "width", "height", "rotation", "rotation_x", "rotation_y")
        return [
            {
                "position": position,
                **dict(zip(fields, map(int, self.request(f"KEY {position}", "KEY", len(fields))))),
            }
            for position in range(positions)
        ]

    def authorize(self):
        self.request("ARM", "ARMED")
        print("Press the keyboard's ZDKM unlock key within 20 seconds.", file=sys.stderr)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.port.write(b"AUTH\n")
            reply = self.read_line()
            if reply == ["OK", "UNLOCKED"]:
                return
            if reply != ["OK", "LOCKED"]:
                raise ProtocolError(f"AUTH returned {' '.join(reply)}")
            time.sleep(0.1)
        raise ProtocolError("keyboard authorization timed out")

    def save(self, command):
        self.authorize()
        self.request(command, "SAVED")
        print("Saved. Release all keys to apply the changes.", file=sys.stderr)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = self.info()["status"]
            if status != "pending":
                return status
            time.sleep(0.1)
        return "pending"


def parse_usage(value):
    named_usages = {"enter": 0x28, "esc": 0x29, "backspace": 0x2A, "tab": 0x2B, "space": 0x2C}
    if value.lower() in named_usages:
        return named_usages[value.lower()]
    if len(value) == 1 and "a" <= value.lower() <= "z":
        return ord(value.lower()) - ord("a") + 0x04
    try:
        return int(value, 16 if value.lower().startswith("0x") else 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("use a key name, letter, or numeric HID usage") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="ZDKM port, such as COM7 or /dev/ttyACM1")
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("info", help="show settings status, limits and position count")
    commands.add_parser("layout", help="list physical position IDs and their coordinates")
    commands.add_parser("list", help="list saved combos")
    set_command = commands.add_parser("set", help="create or replace a combo at a zero-based slot")
    set_command.add_argument("slot", type=int)
    set_command.add_argument("first", type=int)
    set_command.add_argument("second", type=int)
    set_command.add_argument("usage", type=parse_usage, help="e.g. esc, tab, a, or 0x29")
    put_command = commands.add_parser("put", help="configure an extended combo")
    put_command.add_argument("slot", type=int)
    put_command.add_argument("output", type=parse_usage, help="key or action code from 'info'")
    put_command.add_argument("positions", type=int, nargs="+")
    put_command.add_argument("--timeout", type=int, help="time in ms; defaults to the keyboard default")
    put_command.add_argument("--prior-idle", type=int, default=0)
    put_command.add_argument("--layer", type=int, action="append", default=[])
    put_command.add_argument("--slow-release", action="store_true")
    delete_command = commands.add_parser("delete", help="delete one combo")
    delete_command.add_argument("slot", type=int)
    commands.add_parser("reset", help="discard saved changes and restore firmware combo defaults")
    args = parser.parse_args()

    try:
        import serial
    except ImportError:
        parser.exit(1, "Install pyserial with python -m pip install pyserial\n")

    try:
        with serial.Serial(args.port, 115200, timeout=2, write_timeout=2) as port:
            device = Device(port)
            result = device.info()
            caps = device.capabilities() if args.operation in {"info", "list", "put"} else None
            if caps:
                result["capabilities"] = caps
            if args.operation == "layout":
                result["keys"] = device.layout(result["positions"])
            elif args.operation == "list":
                result["combos"] = device.combos(result["slots"], bool(caps))
            elif args.operation == "set":
                result["status"] = device.save(f"SET {args.slot} {args.first} {args.second} {args.usage}")
            elif args.operation == "put":
                if not caps:
                    raise ProtocolError("extended combos require updated firmware")
                timeout = args.timeout if args.timeout is not None else result["timeout_ms"]
                if (not 2 <= len(args.positions) <= caps["keys"] or len(set(args.positions)) != len(args.positions)
                        or any(not 0 <= pos < result["positions"] for pos in args.positions)
                        or any(not 0 <= layer < caps["layers"] for layer in args.layer)
                        or not 1 <= timeout <= 65535 or not 0 <= args.prior_idle <= 65535
                        or not (4 <= args.output <= 0x65 or 0xe0 <= args.output <= 0xe7 or args.output in caps["actions"])):
                    raise ProtocolError("invalid position, layer, timeout, prior idle or output")
                layers = sum(1 << layer for layer in set(args.layer))
                positions = " ".join(map(str, args.positions))
                result["status"] = device.save(
                    f"PUT {args.slot} {args.output} {timeout} {args.prior_idle} "
                    f"{layers} {int(args.slow_release)} {positions}"
                )
            elif args.operation == "delete":
                result["status"] = device.save(f"DEL {args.slot}")
            elif args.operation == "reset":
                result["status"] = device.save("RESET")
            print(json.dumps(result, indent=2))
    except (ProtocolError, serial.SerialException, ValueError) as error:
        parser.exit(1, f"ZDKM: {error}\n")


if __name__ == "__main__":
    main()
