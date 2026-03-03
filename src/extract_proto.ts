/**
 * Extract Model enum values from codeium_common proto.
 */
import { readFileSync } from 'fs';
import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';

const content = readFileSync(
    '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/extension.js',
    'utf-8'
);

// Find all base64 protobuf descriptors
const base64Pattern = /["']([A-Za-z0-9+/]{40,}={0,2})["']/g;
let match;

while ((match = base64Pattern.exec(content)) !== null) {
    const b64 = match[1];
    try {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 20 || buf[0] !== 0x0a) continue;

        const fdp = fromBinary(FileDescriptorProtoSchema, buf);
        if (!fdp.name?.includes('codeium_common')) continue;

        console.log(`═══ ${fdp.name} ═══\n`);

        // Print all enums
        for (const enumType of fdp.enumType) {
            if (enumType.name === 'Model' || enumType.name === 'ModelAlias') {
                console.log(`enum ${enumType.name} {`);
                for (const v of enumType.value) {
                    console.log(`  ${v.name} = ${v.number};`);
                }
                console.log(`}\n`);
            }
        }
    } catch { }
}
