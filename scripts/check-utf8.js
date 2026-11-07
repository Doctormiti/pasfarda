import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function validateTextBuffer(buf, filename = 'test.php') {
  // 1. Check PHP specific rules: BOM and leading output before <?php
  if (filename.endsWith('.php')) {
    // UTF-8 BOM: EF BB BF
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      throw new Error(`[CHECK-UTF8 FAILED] UTF-8 BOM detected at the start of PHP file: ${filename}`);
    }

    // Must start with <?php (no output or whitespace before opening tag)
    const startStr = buf.slice(0, 5).toString('ascii');
    if (startStr !== '<?php') {
      throw new Error(`[CHECK-UTF8 FAILED] Output or whitespace detected before opening <?php tag in: ${filename}`);
    }
  }

  // 2. Check CESU-8 / surrogate sequences (ED A0..BF followed by 80..BF)
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xed && (buf[i + 1] >= 0xa0 && buf[i + 1] <= 0xbf) && (buf[i + 2] >= 0x80 && buf[i + 2] <= 0xbf)) {
      throw new Error(
        `[CHECK-UTF8 FAILED] CESU-8 / surrogate sequence detected at offset ${i} in: ${filename}`
      );
    }
  }

  // 3. Check 4-byte UTF-8 lead bytes (F0-F4) / astral characters (raw emoji forbidden in deliverables)
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0xf0 && b <= 0xf4) {
      throw new Error(
        `[CHECK-UTF8 FAILED] 4-byte UTF-8 astral character lead byte (0x${b.toString(16).toUpperCase()}) detected at offset ${i} in: ${filename}`
      );
    }
  }

  // 4. Check UTF-8 validity
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    throw new Error(`[CHECK-UTF8 FAILED] Invalid UTF-8 byte sequence in: ${filename} (${err.message})`);
  }

  // 5. Check PHP single-quoted strings for unexpanded unicode escapes like '\u{'
  if (filename.endsWith('.php')) {
    const text = buf.toString('utf-8');
    const singleQuoteEscapeRegex = /'(?:\\'|[^'"\r\n])*\\u\{[0-9a-fA-F]+\}(?:\\'|[^'"\r\n])*'/;
    if (singleQuoteEscapeRegex.test(text)) {
      throw new Error(
        `[CHECK-UTF8 FAILED] Single-quoted string containing unexpanded unicode escape \\u{ detected in PHP file: ${filename}. Single quotes prevent escape expansion in PHP. Use double quotes.`
      );
    }
  }

  return true;
}

export function runSelfTestFixtures() {
  // Fixture 1: Broken CESU-8 surrogate sequence -> FAILS
  const surrogateBuf = Buffer.concat([Buffer.from("<?php\n// "), Buffer.from([0xed, 0xa0, 0xbe, 0xed, 0xb7, 0xbe])]);
  let surrogateFailed = false;
  try {
    validateTextBuffer(surrogateBuf, 'fixture-surrogate.php');
  } catch {
    surrogateFailed = true;
  }
  if (!surrogateFailed) throw new Error('[SELF-TEST FAILED] Surrogate fixture did not fail!');

  // Fixture 2: Raw 4-byte UTF-8 emoji (F0 9F A7 BE) -> FAILS
  const rawEmojiBuf = Buffer.concat([Buffer.from('<?php\n$msg = "'), Buffer.from([0xf0, 0x9f, 0xa7, 0xbe]), Buffer.from('";')]);
  let rawEmojiFailed = false;
  try {
    validateTextBuffer(rawEmojiBuf, 'fixture-emoji.php');
  } catch {
    rawEmojiFailed = true;
  }
  if (!rawEmojiFailed) throw new Error('[SELF-TEST FAILED] Raw emoji fixture did not fail!');

  // Fixture 3: Escaped unicode form (\u{1F9FE}) -> PASSES
  const escapedBuf = Buffer.from('<?php\n$msg = "\\u{1F9FE}";');
  validateTextBuffer(escapedBuf, 'fixture-escaped.php');

  // Fixture 4: Invalid UTF-8 sequence -> FAILS
  const invalidBuf = Buffer.from([0xff, 0xfe, 0x80, 0x00]);
  let invalidFailed = false;
  try {
    validateTextBuffer(invalidBuf, 'fixture-invalid.ts');
  } catch {
    invalidFailed = true;
  }
  if (!invalidFailed) throw new Error('[SELF-TEST FAILED] Invalid UTF-8 fixture did not fail!');

  // Fixture 5: Single-quoted string with \\u{...} in PHP -> FAILS
  const singleQuotedBuf = Buffer.from("<?php\n$msg = '\\u{1F9FE}';");
  let singleQuotedFailed = false;
  try {
    validateTextBuffer(singleQuotedBuf, 'fixture-single-quote.php');
  } catch {
    singleQuotedFailed = true;
  }
  if (!singleQuotedFailed) throw new Error('[SELF-TEST FAILED] Single-quoted unicode escape fixture did not fail!');

  return true;
}

export function scanUtf8(rootDir = process.cwd(), options = {}) {
  const ignoredDirs = new Set(['node_modules', '.git', '.aistudio']);
  const textExts = /\.(php|ts|tsx|js|jsx|json|html|css|txt|md|yml|yaml|webmanifest)$/i;

  let scannedCount = 0;

  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredDirs.has(entry.name)) continue;
      // In early scan before build, skip dist/public_html_ready if options.skipDist is set
      if (options.skipDist && (entry.name === 'dist' || entry.name === 'public_html_ready')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && textExts.test(entry.name)) {
        // Exclude test suite files that contain negative test fixtures
        if (fullPath.includes('tests/pure_logic.test.ts') || fullPath.includes('tests/test_onival_suite.php')) {
          continue;
        }
        scannedCount++;
        const buf = fs.readFileSync(fullPath);
        validateTextBuffer(buf, fullPath);
      }
    }
  }

  scan(rootDir);
  return { ok: true, scannedCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runSelfTestFixtures();
    console.log('✓ [GATE CHECK-UTF8 SELF-TESTS PASSED] All fixtures verified.');
    const skipDist = process.argv.includes('--pre-build') || process.argv.includes('--source-only');
    const res = scanUtf8(process.cwd(), { skipDist });
    console.log(`✓ [GATE CHECK-UTF8 PASSED] Scanned ${res.scannedCount} text files. All UTF-8, no-astral, and PHP rules valid.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
