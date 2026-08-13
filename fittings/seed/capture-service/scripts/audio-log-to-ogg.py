#!/usr/bin/env python3
"""Parse capture audio.log ([u32 LE seq][f64 LE ts_millis][u32 LE len][payload])
and mux raw opus packets into an Ogg Opus file."""
import struct, sys, os

def parse_log(path):
    pkts = []
    with open(path, 'rb') as f:
        data = f.read()
    off = 0
    n = len(data)
    while off + 16 <= n:
        seq, = struct.unpack_from('<I', data, off)
        ts, = struct.unpack_from('<d', data, off+4)
        ln, = struct.unpack_from('<I', data, off+12)
        off += 16
        if off + ln > n:
            print(f"WARN truncated record at off {off}, len {ln}", file=sys.stderr)
            break
        pkts.append((seq, ts, data[off:off+ln]))
        off += ln
    return pkts

# Ogg CRC32: poly 0x04C11DB7, init 0, no reflect, no final xor
_tab = []
for i in range(256):
    r = i << 24
    for _ in range(8):
        r = ((r << 1) ^ 0x04C11DB7) if (r & 0x80000000) else (r << 1)
        r &= 0xFFFFFFFF
    _tab.append(r)

def ogg_crc(buf):
    r = 0
    for b in buf:
        r = ((r << 8) & 0xFFFFFFFF) ^ _tab[((r >> 24) & 0xFF) ^ b]
    return r

def ogg_page(serial, pageno, granule, packets, header_type=0):
    segtable = b''
    body = b''
    for pkt in packets:
        l = len(pkt)
        while l >= 255:
            segtable += bytes([255]); l -= 255
        segtable += bytes([l])
        body += pkt
    hdr = struct.pack('<4sBBqIIIB', b'OggS', 0, header_type,
                      granule & 0xFFFFFFFFFFFFFFFF, serial, pageno, 0, len(segtable)) + segtable
    page = bytearray(hdr + body)
    crc = ogg_crc(page)
    struct.pack_into('<I', page, 22, crc)
    return bytes(page)

def mux(pkts, out_path, serial=0x47415252):
    # OpusHead: magic, ver=1, ch=1, preskip=0, input_sr=16000, gain=0, mapping=0
    opus_head = struct.pack('<8sBBHIhB', b'OpusHead', 1, 1, 0, 16000, 0, 0)
    opus_tags = struct.pack('<8sI', b'OpusTags', 8) + b'garrison' + struct.pack('<I', 0)
    pages = []
    pages.append(ogg_page(serial, 0, 0, [opus_head], header_type=2))
    pages.append(ogg_page(serial, 1, 0, [opus_tags]))
    pageno = 2
    granule = 0
    # group ~50 packets per page
    i = 0
    while i < len(pkts):
        chunk = pkts[i:i+50]
        granule += 960 * len(chunk)  # 20ms @48k granule units
        htype = 4 if i + 50 >= len(pkts) else 0
        pages.append(ogg_page(serial, pageno, granule, [p[2] for p in chunk], header_type=htype))
        pageno += 1
        i += 50
    with open(out_path, 'wb') as f:
        for p in pages:
            f.write(p)

if __name__ == '__main__':
    log, out = sys.argv[1], sys.argv[2]
    pkts = parse_log(log)
    seqs = [p[0] for p in pkts]
    tss = [p[1] for p in pkts]
    lens = [len(p[2]) for p in pkts]
    gaps = sum(1 for a, b in zip(seqs, seqs[1:]) if b != a + 1)
    dts = [b - a for a, b in zip(tss, tss[1:])]
    print(f"packets={len(pkts)} seq_first={seqs[0]} seq_last={seqs[-1]} seq_gaps={gaps}")
    print(f"ts_span_ms={tss[-1]-tss[0]:.1f} expected_ms={20*len(pkts)}")
    print(f"pkt_len min={min(lens)} max={max(lens)} mean={sum(lens)/len(lens):.1f}")
    if dts:
        import statistics
        print(f"inter_ts_ms median={statistics.median(dts):.2f} max={max(dts):.1f}")
    # TOC byte analysis of first packets
    from collections import Counter
    tocs = Counter(p[2][0] for p in pkts if p[2])
    print("TOC bytes:", {hex(k): v for k, v in tocs.most_common(6)})
    mux(pkts, out)
    print(f"wrote {out}")
