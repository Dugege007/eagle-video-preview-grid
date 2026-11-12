#!/usr/bin/env python3
"""生成 manifest 使用的 logo.png（3x3 预览图网格）。

仅使用 Python 标准库，不引入 Pillow 等第三方依赖；
重新生成：python tools/make_logo.py
"""

import os
import struct
import zlib

SIZE = 128
BG = (30, 37, 48)
MARGIN = 18
GAP = 8


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def color_at(x, y):
    cw = (SIZE - 2 * MARGIN - 2 * GAP) // 3
    for row in range(3):
        top = MARGIN + row * (cw + GAP)
        for col in range(3):
            left = MARGIN + col * (cw + GAP)
            if left <= x < left + cw and top <= y < top + cw:
                t = (col + row * 3) / 8.0
                return (
                    int(70 + 150 * t),
                    int(130 + 80 * t),
                    int(220 - 40 * t),
                )
    return BG


def main():
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)  # PNG filter type: None
        for x in range(SIZE):
            r, g, b = color_at(x, y)
            raw += bytes((r, g, b, 255))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )

    out = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logo.png"
    )
    with open(out, "wb") as f:
        f.write(png)
    print("wrote", out, len(png), "bytes")


if __name__ == "__main__":
    main()
