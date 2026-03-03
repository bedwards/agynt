/**
 * Minimal protobuf encoder/decoder for constructing gRPC messages
 * without .proto files. Handles varint, length-delimited, and nested messages.
 */

// ── Wire types ──────────────────────────────────────────────────────

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32BIT = 5;

// ── Encoding primitives ─────────────────────────────────────────────

export function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value >>> 0; // treat as unsigned 32-bit
    while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
}

export function encodeTag(fieldNumber: number, wireType: number): Buffer {
    return encodeVarint((fieldNumber << 3) | wireType);
}

export function encodeString(fieldNumber: number, value: string): Buffer {
    const strBuf = Buffer.from(value, "utf-8");
    return Buffer.concat([
        encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED),
        encodeVarint(strBuf.length),
        strBuf,
    ]);
}

export function encodeBytes(fieldNumber: number, value: Buffer): Buffer {
    return Buffer.concat([
        encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED),
        encodeVarint(value.length),
        value,
    ]);
}

export function encodeEnum(fieldNumber: number, value: number): Buffer {
    return Buffer.concat([
        encodeTag(fieldNumber, WIRE_VARINT),
        encodeVarint(value),
    ]);
}

export function encodeInt(fieldNumber: number, value: number): Buffer {
    return encodeEnum(fieldNumber, value); // same encoding
}

export function encodeBool(fieldNumber: number, value: boolean): Buffer {
    return Buffer.concat([
        encodeTag(fieldNumber, WIRE_VARINT),
        encodeVarint(value ? 1 : 0),
    ]);
}

export function encodeMessage(fieldNumber: number, inner: Buffer): Buffer {
    return Buffer.concat([
        encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED),
        encodeVarint(inner.length),
        inner,
    ]);
}

// ── Decoding primitives ─────────────────────────────────────────────

export interface ProtoField {
    fieldNumber: number;
    wireType: number;
    value: Buffer | number | bigint;
    children?: ProtoField[];
}

export function decodeVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset + bytesRead < buf.length) {
        const byte = buf[offset + bytesRead];
        result |= (byte & 0x7f) << shift;
        bytesRead++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    return { value: result >>> 0, bytesRead };
}

export function decodeMessage(buf: Buffer): ProtoField[] {
    const fields: ProtoField[] = [];
    let offset = 0;

    while (offset < buf.length) {
        const tag = decodeVarint(buf, offset);
        offset += tag.bytesRead;

        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x07;

        if (fieldNumber === 0) break;

        switch (wireType) {
            case WIRE_VARINT: {
                const val = decodeVarint(buf, offset);
                offset += val.bytesRead;
                fields.push({ fieldNumber, wireType, value: val.value });
                break;
            }
            case WIRE_64BIT: {
                const val = buf.subarray(offset, offset + 8);
                offset += 8;
                fields.push({ fieldNumber, wireType, value: val });
                break;
            }
            case WIRE_LENGTH_DELIMITED: {
                const len = decodeVarint(buf, offset);
                offset += len.bytesRead;
                const val = buf.subarray(offset, offset + len.value);
                offset += len.value;

                // Try to recursively decode as a nested message
                let children: ProtoField[] | undefined;
                try {
                    const nested = decodeMessage(val);
                    if (nested.length > 0 && nested.every(f => f.fieldNumber > 0 && f.fieldNumber < 1000)) {
                        children = nested;
                    }
                } catch {
                    // Not a valid nested message — treat as bytes/string
                }

                fields.push({ fieldNumber, wireType, value: val, children });
                break;
            }
            case WIRE_32BIT: {
                const val = buf.subarray(offset, offset + 4);
                offset += 4;
                fields.push({ fieldNumber, wireType, value: val });
                break;
            }
            default:
                // Unknown wire type — stop parsing
                return fields;
        }
    }

    return fields;
}

export function printFields(fields: ProtoField[], indent = 0): string {
    const pad = "  ".repeat(indent);
    const lines: string[] = [];

    for (const f of fields) {
        if (f.wireType === WIRE_VARINT) {
            lines.push(`${pad}field ${f.fieldNumber} (varint): ${f.value}`);
        } else if (f.wireType === WIRE_LENGTH_DELIMITED) {
            const buf = f.value as Buffer;
            const readable = buf.toString("utf-8");
            const isPrintable = /^[\x20-\x7e\n\r\t]+$/.test(readable);

            if (f.children) {
                lines.push(`${pad}field ${f.fieldNumber} (message):`);
                lines.push(printFields(f.children, indent + 1));
            } else if (isPrintable && buf.length < 200) {
                lines.push(`${pad}field ${f.fieldNumber} (string): "${readable}"`);
            } else {
                lines.push(`${pad}field ${f.fieldNumber} (bytes): [${buf.length} bytes] ${buf.toString("hex").slice(0, 60)}...`);
            }
        } else if (f.wireType === WIRE_64BIT || f.wireType === WIRE_32BIT) {
            const buf = f.value as Buffer;
            lines.push(`${pad}field ${f.fieldNumber} (${f.wireType === WIRE_64BIT ? "64bit" : "32bit"}): ${buf.toString("hex")}`);
        }
    }

    return lines.join("\n");
}

/**
 * Find all instances of a field by number in decoded fields.
 */
export function findField(fields: ProtoField[], fieldNumber: number): ProtoField | undefined {
    return fields.find(f => f.fieldNumber === fieldNumber);
}

export function findAllFields(fields: ProtoField[], fieldNumber: number): ProtoField[] {
    return fields.filter(f => f.fieldNumber === fieldNumber);
}

export function getStringValue(fields: ProtoField[], fieldNumber: number): string | undefined {
    const field = findField(fields, fieldNumber);
    if (field && field.wireType === WIRE_LENGTH_DELIMITED) {
        return (field.value as Buffer).toString("utf-8");
    }
    return undefined;
}

export function getIntValue(fields: ProtoField[], fieldNumber: number): number | undefined {
    const field = findField(fields, fieldNumber);
    if (field && field.wireType === WIRE_VARINT) {
        return field.value as number;
    }
    return undefined;
}
