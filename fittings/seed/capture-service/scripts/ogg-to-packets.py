#!/usr/bin/env python3
"""Extract raw Opus packets from an Ogg-Opus file.

Walks Ogg pages (RFC 3533): 27-byte header, segment lacing table, packets end
on a lacing value < 255 and may continue across pages. The first two packets
of an Opus stream are OpusHead and OpusTags (RFC 7845) and are stripped —
the wire protocol and Deepgram's encoding=opus both want bare audio packets.

Prints one JSON object per audio packet: {"seq": n, "ts": ms, "bytes": b64}
with ts advancing 20 ms per packet (the encoder is pinned to 20 ms frames).
"""

import base64
import json
import struct
import sys

PACKET_MS = 20


def ogg_packets(data: bytes):
    offset = 0
    partial = b""
    while offset + 27 <= len(data):
        if data[offset : offset + 4] != b"OggS":
            raise SystemExit(f"bad Ogg capture pattern at byte {offset}")
        n_segments = data[offset + 26]
        table = data[offset + 27 : offset + 27 + n_segments]
        body = offset + 27 + n_segments
        for lacing in table:
            partial += data[body : body + lacing]
            body += lacing
            if lacing < 255:
                yield partial
                partial = b""
        offset = body
    if partial:
        yield partial  # truncated final packet: emit what we have


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: ogg-to-packets.py <file.ogg>")
    with open(sys.argv[1], "rb") as f:
        data = f.read()
    seq = 0
    for i, packet in enumerate(ogg_packets(data)):
        if i < 2:  # OpusHead, OpusTags
            continue
        if not packet:
            continue
        seq += 1
        print(
            json.dumps(
                {
                    "seq": seq,
                    "ts": (seq - 1) * PACKET_MS,
                    "bytes": base64.b64encode(packet).decode(),
                }
            )
        )


if __name__ == "__main__":
    main()
