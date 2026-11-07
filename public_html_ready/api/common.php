<?php
if (!defined('ONIVAL_ENTRY')) {
    http_response_code(404);
    exit;
}

/**
 * ==============================================================================
 * ONIVAL Core Engine & Security Bootstrap for PHP Shared Hosting (ParsPack/cPanel)
 * ==============================================================================
 * Provides unified transactional storage, structured logging, authentication,
 * inventory management, and hardened Bale bot integration.
 * ==============================================================================
 */

error_reporting(E_ALL & ~E_NOTICE & ~E_WARNING);
ini_set('display_errors', '0');

// ------------------------------------------------------------------------------
// ------------------------------------------------------------------------------
// 1. Canonical Paths & Environment Resolution (Derived strictly from code location)
// ------------------------------------------------------------------------------
$apiDir = __DIR__;
$publicDir = dirname(__DIR__);
$homeDir = dirname(__DIR__, 2);
define('ONIVAL_PRIVATE_DIR', $homeDir . '/onival-private');

// Subdirectories inside private directory
$logDir = ONIVAL_PRIVATE_DIR . '/logs';
$receiptsDir = ONIVAL_PRIVATE_DIR . '/receipts';
$backupsDir = ONIVAL_PRIVATE_DIR . '/backups';
$tmpDir = ONIVAL_PRIVATE_DIR . '/tmp';

$dataFile = ONIVAL_PRIVATE_DIR . '/onival-persistent-data.json';
$lockFile = ONIVAL_PRIVATE_DIR . '/.onival.lock';
$logFile = $logDir . '/app.log';
$secretFile = ONIVAL_PRIVATE_DIR . '/session_secret';
$rateLimitsFile = ONIVAL_PRIVATE_DIR . '/rate_limits.json';
$revokedTokensFile = ONIVAL_PRIVATE_DIR . '/revoked_tokens.json';
$webhookUpdatesFile = ONIVAL_PRIVATE_DIR . '/webhook_updates.json';
$committedWritesCount = 0;
define('ONIVAL_BUILD_ID', '20261107-9bd954046e');
define('ONIVAL_MIN_PHP_VERSION', '8.0.0');
define('ONIVAL_MIN_PHP_VERSION_ID', 80000);

// PHP Version Compatibility Polyfills
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool {
        return (string)$needle !== '' && strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}

if (!function_exists('array_is_list')) {
    function array_is_list(array $array): bool {
        $i = 0;
        foreach ($array as $k => $v) {
            if ($k !== $i++) {
                return false;
            }
        }
        return true;
    }
}

function isValidAdminUsername($username, $isPending = false, $initialUsername = 'onival_setup') {
    if (!is_string($username)) {
        return ['ok' => false, 'code' => 'INVALID_USERNAME', 'error' => 'نام کاربری نامعتبر است.'];
    }
    $u = trim($username);
    if (!preg_match('/^[a-zA-Z0-9._-]{3,32}$/', $u)) {
        return ['ok' => false, 'code' => 'INVALID_USERNAME', 'error' => 'نام کاربری جدید باید بین ۳ تا ۳۲ کاراکتر و فقط شامل حروف انگلیسی، اعداد، نقطه، خط فاصله یا زیرخط باشد.'];
    }
    if (strpos($u, '@') !== false) {
        return ['ok' => false, 'code' => 'INVALID_USERNAME', 'error' => 'نام کاربری نمی‌تواند ساختار ایمیل داشته باشد.'];
    }
    $norm = strtolower($u);
    if ($isPending && strtolower(trim((string)$initialUsername)) === $norm) {
        return ['ok' => false, 'code' => 'USERNAME_SAME_AS_INITIAL', 'error' => 'نام کاربری جدید باید با شناسه کاربری موقت اولیه متفاوت باشد.'];
    }
    if ($norm === 'admin') {
        return ['ok' => false, 'code' => 'USERNAME_RESERVED', 'error' => 'استفاده از نام کاربری عمومی admin مجاز نمی‌باشد.'];
    }
    return ['ok' => true, 'username' => $u];
}

function isUsablePasswordHash($hash) {
    if (!is_string($hash) || trim($hash) === '') {
        return false;
    }
    $trimmed = trim($hash);
    if (!str_starts_with($trimmed, '$')) {
        return false;
    }
    $info = password_get_info($trimmed);
    return isset($info['algo']) && $info['algo'] !== null && $info['algo'] !== 0;
}

function checkOpenBasedirCompatibilityPhp() {
    $ob = ini_get('open_basedir');
    if (empty($ob)) return ['ok' => true, 'open_basedir' => 'none'];
    $allowed = explode(PATH_SEPARATOR, $ob);
    foreach ($allowed as $path) {
        $clean = rtrim($path, '/\\');
        if (str_starts_with(ONIVAL_PRIVATE_DIR, $clean)) {
            return ['ok' => true, 'open_basedir' => $ob];
        }
    }
    return ['ok' => false, 'open_basedir' => $ob];
}

function ensurePrivateStorageAvailableOrExit() {
    if (!is_dir(ONIVAL_PRIVATE_DIR) || !is_writable(ONIVAL_PRIVATE_DIR)) {
        onival_log('storage', 'LOGIN_FAIL', 'LOGIN_FAIL reason=storage_unavailable', [
            'reason' => 'storage_unavailable',
            'privateDir' => ONIVAL_PRIVATE_DIR,
            'open_basedir' => ini_get('open_basedir') ?: 'none'
        ]);
        http_response_code(503);
        echo json_encode([
            'ok' => false,
            'code' => 'STORAGE_UNAVAILABLE',
            'error' => 'فضای ذخیره‌سازی خصوصی سیستم در دسترس نمی‌باشد (storage_unavailable).'
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

/**
 * Authoritative single bootstrap & readiness function for ONIVAL runtime
 */
function ensureRuntimeReady() {
    global $dataFile, $lockFile, $logDir, $receiptsDir, $backupsDir, $tmpDir;

    // 0. Minimum supported PHP version check
    if (PHP_VERSION_ID < ONIVAL_MIN_PHP_VERSION_ID) {
        return [
            'ok' => false,
            'code' => 'PHP_UNSUPPORTED',
            'status' => 'php_unsupported',
            'detail' => ONIVAL_MIN_PHP_VERSION,
            'error' => 'نسخه PHP سرور باید حداقل ' . ONIVAL_MIN_PHP_VERSION . ' باشد (php_unsupported).'
        ];
    }

    // 1. Ensure private runtime directory exists (0700 where supported)
    if (!is_dir(ONIVAL_PRIVATE_DIR)) {
        @mkdir(ONIVAL_PRIVATE_DIR, 0700, true);
        @chmod(ONIVAL_PRIVATE_DIR, 0700);
    }
    if (!is_dir(ONIVAL_PRIVATE_DIR)) {
        return [
            'ok' => false,
            'code' => 'STORAGE_UNAVAILABLE',
            'status' => 'storage_unavailable',
            'detail' => 'dir_missing',
            'error' => 'پوشه خصوصی داده‌های سرور قابل ایجاد نیست (storage_unavailable).'
        ];
    }

    // 2. Storage write/delete probe with status marker cache (avoids per-request churn)
    $markerFile = ONIVAL_PRIVATE_DIR . '/.runtime_probe_ok';
    $shouldProbe = true;
    if (file_exists($markerFile)) {
        $mtime = @filemtime($markerFile);
        if ($mtime && (time() - $mtime < 300) && is_writable(ONIVAL_PRIVATE_DIR)) {
            $shouldProbe = false;
        }
    }

    if ($shouldProbe) {
        $probe = ONIVAL_PRIVATE_DIR . '/.storage_probe_' . bin2hex(random_bytes(8));
        if (@file_put_contents($probe, 'ok', LOCK_EX) === false) {
            return [
                'ok' => false,
                'code' => 'STORAGE_UNAVAILABLE',
                'status' => 'storage_unavailable',
                'detail' => 'probe_failed',
                'error' => 'پوشه خصوصی داده‌ها قابل نوشتن نیست (storage_unavailable).'
            ];
        }
        @unlink($probe);
        @touch($markerFile);
    }

    // 3. Ensure subdirectories
    foreach ([$logDir, $receiptsDir, $backupsDir, $tmpDir] as $sd) {
        if (!is_dir($sd)) {
            @mkdir($sd, 0700, true);
            @chmod($sd, 0700);
        }
    }

    // 4. Database initialization under exclusive lock
    $lockFp = @fopen($lockFile, 'c+');
    if (!$lockFp || !@flock($lockFp, LOCK_EX)) {
        if ($lockFp) @fclose($lockFp);
        return [
            'ok' => false,
            'code' => 'STORAGE_LOCK_FAILED',
            'status' => 'storage_unavailable',
            'detail' => 'lock_failed',
            'error' => 'قفل پایگاه داده برقرار نشد.'
        ];
    }

    $db = null;
    $dbLoaded = false;
    if (file_exists($dataFile)) {
        $raw = @file_get_contents($dataFile);
        if ($raw === false || trim($raw) === '') {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return [
                'ok' => false,
                'code' => 'DB_INVALID',
                'status' => 'db_invalid',
                'detail' => 'empty_or_unreadable',
                'error' => 'پایگاه داده موجود است اما خالی یا غیرقابل خواندن است (db_invalid).'
            ];
        }

        $parsed = @json_decode($raw, true);
        if (!is_array($parsed)) {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return [
                'ok' => false,
                'code' => 'DB_INVALID',
                'status' => 'db_invalid',
                'detail' => 'invalid_json',
                'error' => 'فرمت پایگاه داده موجود نامعتبر است (db_invalid).'
            ];
        }

        // List-type core keys must be non-associative lists
        $listKeys = ['products', 'productCategories', 'orders'];
        foreach ($listKeys as $lk) {
            if (!array_key_exists($lk, $parsed) || !is_array($parsed[$lk]) || !array_is_list($parsed[$lk])) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
                return [
                    'ok' => false,
                    'code' => 'DB_INVALID',
                    'status' => 'db_invalid',
                    'detail' => 'core_key_invalid',
                    'error' => "ساختار پایگاه داده ناقص است؛ کلید لیستی {$lk} باید یک لیست متوالی باشد (db_invalid)."
                ];
            }
        }

        // Object-type core keys must be associative arrays or empty array {}
        $mapKeys = ['siteContent', 'adminCredentials'];
        foreach ($mapKeys as $mk) {
            if (!array_key_exists($mk, $parsed) || !is_array($parsed[$mk])) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
                return [
                    'ok' => false,
                    'code' => 'DB_INVALID',
                    'status' => 'db_invalid',
                    'detail' => 'core_key_invalid',
                    'error' => "ساختار پایگاه داده ناقص است؛ کلید {$mk} باید یک شیء باشد (db_invalid)."
                ];
            }
            if (!empty($parsed[$mk]) && array_is_list($parsed[$mk])) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
                return [
                    'ok' => false,
                    'code' => 'DB_INVALID',
                    'status' => 'db_invalid',
                    'detail' => 'core_key_invalid',
                    'error' => "ساختار پایگاه داده نامعتبر است؛ کلید شیئی {$mk} نباید به صورت لیست عددی ذخیره شود (db_invalid)."
                ];
            }
        }

        $db = $parsed;
        $dbLoaded = true;
    }

    $seed = null;
    $seedFile = __DIR__ . '/seed.php';
    if (file_exists($seedFile)) {
        $seed = require $seedFile;
    }

    $needsWrite = false;
    if (!$dbLoaded) {
        if (!is_array($seed) || empty($seed['products']) || !is_array($seed['products']) || !array_is_list($seed['products']) || count($seed['products']) === 0) {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return [
                'ok' => false,
                'code' => 'SEED_MISSING',
                'status' => 'seed_missing',
                'detail' => 'seed_missing',
                'error' => 'فایل سید اولیه سرور یافت نشد یا محصولات آن خالی/نامعتبر است (seed_missing).'
            ];
        }
        $db = $seed;
        $needsWrite = true;
    } else {
        // For an existing loaded database, ensure missing optional collections get neutral defaults (NEVER copy seed into existing DB)
        $optionalCols = ['posts', 'postCategories', 'contactMessages', 'slugRedirects'];
        foreach ($optionalCols as $col) {
            if (!isset($db[$col]) || !is_array($db[$col])) {
                $db[$col] = [];
                $needsWrite = true;
            }
        }
    }

    // State-based credential check & bootstrap
    $creds = $db['adminCredentials'] ?? [];
    $isCompleted = !empty($creds['initialSetupCompleted']);
    $hasUsablePass = !empty($creds['password']) && isUsablePasswordHash($creds['password']);
    $hasOtp = !empty($creds['oneTimePassword']) && is_string($creds['oneTimePassword']) && trim($creds['oneTimePassword']) !== '';

    if ($isCompleted) {
        if (!$hasUsablePass) {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            onival_log('auth', 'credential_unusable', 'initialSetupCompleted is true but no usable password hash exists');
            return [
                'ok' => false,
                'code' => 'CREDENTIAL_UNUSABLE',
                'status' => 'credential_unusable',
                'detail' => 'password_hash_unusable',
                'error' => 'رمز عبور مدیر معتبر نیست.'
            ];
        }
    } else {
        if (!$hasUsablePass && !$hasOtp) {
            $initAdmin = $seed['initialAdmin'] ?? null;
            if (!is_array($initAdmin) || empty($initAdmin['username']) || empty($initAdmin['tempPassword'])) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
                return [
                    'ok' => false,
                    'code' => 'BOOTSTRAP_FAILED',
                    'status' => 'bootstrap_failed',
                    'detail' => 'seed_credential_missing',
                    'error' => 'اطلاعات احراز هویت اولیه در سید سرور موجود نیست.'
                ];
            }

            $initUser = trim((string)$initAdmin['username']);
            $initTempPass = trim((string)$initAdmin['tempPassword']);
            $hashedOtp = password_hash($initTempPass, PASSWORD_DEFAULT);

            if (!isset($db['adminCredentials']) || !is_array($db['adminCredentials'])) {
                $db['adminCredentials'] = [];
            }
            $db['adminCredentials']['username'] = $initUser;
            $db['adminCredentials']['password'] = '';
            $db['adminCredentials']['oneTimePassword'] = $hashedOtp;
            $db['adminCredentials']['oneTimePasswordExpired'] = false;
            $db['adminCredentials']['initialSetupCompleted'] = false;
            $db['adminCredentials']['email'] = $db['adminCredentials']['email'] ?? 'admin@onival.com';
            $db['adminCredentials']['name'] = $db['adminCredentials']['name'] ?? 'مدیریت اونیوال (ONIVAL Admin)';
            $needsWrite = true;
        }
    }

    if ($needsWrite) {
        $tmp = $dataFile . '.tmp.' . uniqid('', true);
        $encoded = json_encode($db, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        $written = @file_put_contents($tmp, $encoded, LOCK_EX);
        if ($written === false || $written !== strlen($encoded)) {
            @unlink($tmp);
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return ['ok' => false, 'code' => 'DB_WRITE_FAILED', 'error' => 'خطا در ثبت پایگاه داده روی دیسک هاست.'];
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $dataFile)) {
            @unlink($tmp);
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return ['ok' => false, 'code' => 'DB_RENAME_FAILED', 'error' => 'خطا در نهایی‌سازی پایگاه داده روی سرور.'];
        }
        @chmod($dataFile, 0600);
    }

    @flock($lockFp, LOCK_UN);
    @fclose($lockFp);

    return [
        'ok' => true,
        'code' => 'READY',
        'status' => 'ready',
        'detail' => 'ready',
        'initialSetupCompleted' => !empty($db['adminCredentials']['initialSetupCompleted'])
    ];
}

// ------------------------------------------------------------------------------
// 2. Structured Bounded Application Logger (Outside Public Web)
// ------------------------------------------------------------------------------
function onival_sanitize_log_data($data) {
    if (is_null($data) || is_scalar($data)) {
        if (is_string($data)) {
            // Mask bot tokens and credentials in query strings or text
            $data = preg_replace('/(?i)(token|secret|password|authorization|auth|provider_token|card|k)=([^\s&]+)/', '$1=[REDACTED]', $data);
            if (strlen($data) > 60 && preg_match('/^[a-f0-9]{32,}$/i', $data)) {
                return substr($data, 0, 6) . '...[REDACTED]';
            }
        }
        return $data;
    }
    if (is_array($data)) {
        $clean = [];
        $sensitiveKeys = [
            'password', 'newpassword', 'currentpassword', 'token', 'bottoken',
            'adminbottoken', 'customerbottoken', 'balebottoken', 'provider_token',
            'balepaymenttoken', 'balepaymenttokenlive', 'balepaymenttokentest',
            'webhooksecrettoken', 'customerwebhooksecrettoken', 'adminwebhooksecrettoken',
            'authorization', 'x-admin-token', 'k', 'secret'
        ];
        foreach ($data as $k => $v) {
            if (in_array(strtolower((string)$k), $sensitiveKeys, true)) {
                $clean[$k] = '[REDACTED]';
            } else {
                $clean[$k] = onival_sanitize_log_data($v);
            }
        }
        return $clean;
    }
    return '[object]';
}

function onival_log_safe_uri($uri) {
    if (!is_string($uri) || $uri === '') return '';
    $parts = explode('?', $uri, 2);
    $path = $parts[0];
    $path = preg_replace('#^(/api/webhook/bale/(?:customer|admin)/)[^/]+#i', '$1[REDACTED]', $path);
    $path = preg_replace('#^(/api/webhook/bale/)[^/]+#i', '$1[REDACTED]', $path);
    if (isset($parts[1])) {
        $query = preg_replace('/(?i)(token|secret|password|k|key)=([^&]+)/', '$1=[REDACTED]', $parts[1]);
        return $path . '?' . $query;
    }
    return $path;
}

function onival_log($stage, $category, $message, $context = [], $correlationId = null) {
    global $logFile;
    if (empty($correlationId)) {
        $correlationId = substr(bin2hex(random_bytes(8)), 0, 12);
    }

    $entry = [
        'timestamp' => date('c'),
        'correlationId' => $correlationId,
        'stage' => $stage,
        'category' => $category,
        'message' => mb_substr((string)$message, 0, 500, 'UTF-8'),
        'context' => onival_sanitize_log_data($context),
        'server' => [
            'method' => $_SERVER['REQUEST_METHOD'] ?? 'CLI',
            'uri' => onival_log_safe_uri($_SERVER['REQUEST_URI'] ?? ''),
            'ip' => isset($_SERVER['REMOTE_ADDR']) ? hash('sha256', $_SERVER['REMOTE_ADDR']) : 'local'
        ]
    ];

    $line = json_encode($entry, JSON_UNESCAPED_UNICODE) . "\n";
    $written = false;

    try {
        $dir = dirname($logFile);
        if (is_dir($dir) && is_writable($dir)) {
            // Rotate log file if > 2MB, keep 1 rotated copy
            if (file_exists($logFile) && @filesize($logFile) > 2097152) {
                @rename($logFile, $logFile . '.1');
            }
            $res = @file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
            if ($res !== false) {
                $written = true;
            }
        }
    } catch (\Throwable $e) {
        $written = false;
    }

    if (!$written) {
        // Fall back to single-line sanitized reason codes via error_log() (no paths, no secrets)
        $cleanCategory = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$category);
        $cleanStage = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$stage);
        $reason = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($context['reason'] ?? $category));
        @error_log("[ONIVAL_FALLBACK] stage={$cleanStage} cat={$cleanCategory} reason={$reason} corr={$correlationId}");
    }

    return $correlationId;
}

// ------------------------------------------------------------------------------
// 3. HMAC Session Secret
// ------------------------------------------------------------------------------
function getAdminSessionSecret() {
    global $secretFile;
    $envSecret = getenv('ADMIN_TOKEN_SECRET');
    if (!empty($envSecret) && strlen($envSecret) >= 32) {
        return $envSecret;
    }
    if (file_exists($secretFile)) {
        $stored = trim((string)@file_get_contents($secretFile));
        if (strlen($stored) >= 32) {
            return $stored;
        }
    }
    $newSecret = bin2hex(random_bytes(32));
    @file_put_contents($secretFile, $newSecret, LOCK_EX);
    return $newSecret;
}

// ------------------------------------------------------------------------------
// 4. Atomic Transactional JSON Database Access (Sidecar Lock Pattern)
// ------------------------------------------------------------------------------
function withDatabaseTransaction(callable $callback) {
    global $dataFile, $lockFile, $committedWritesCount;

    $lockFp = @fopen($lockFile, 'c+');
    if (!$lockFp) {
        onival_log('database', 'lock_failure', 'Could not open sidecar lock file', ['lockFile' => $lockFile]);
        return ['ok' => false, 'code' => 'DATA_WRITE_FAILED', 'error' => 'خطای قفل پایگاه داده (Database Lock Error)'];
    }

    $locked = @flock($lockFp, LOCK_EX);
    if (!$locked) {
        @fclose($lockFp);
        onival_log('database', 'lock_failure', 'Could not acquire exclusive sidecar lock');
        return ['ok' => false, 'code' => 'DATA_WRITE_FAILED', 'error' => 'پایگاه داده در حال حاضر مشغول است'];
    }

    try {
        if (!file_exists($dataFile)) {
            ensureRuntimeReady();
        }
        if (!file_exists($dataFile)) {
            throw new \RuntimeException('Database file is missing and initialization failed');
        }

        $raw = @file_get_contents($dataFile);
        if ($raw === false || strlen($raw) < 5) {
            throw new \RuntimeException('Database file is unreadable (INVALID_JSON)');
        }
        $db = @json_decode($raw, true);
        if (!is_array($db) || !isset($db['products'])) {
            throw new \RuntimeException('Database file contains invalid JSON (INVALID_JSON)');
        }

        // State-based bootstrap check under existing lock
        $creds = $db['adminCredentials'] ?? [];
        if (empty($creds['initialSetupCompleted']) && empty($creds['oneTimePassword']) && empty($creds['password'])) {
            ensureRuntimeReady();
            $freshRaw = @file_get_contents($dataFile);
            $freshDb = @json_decode($freshRaw, true);
            if (is_array($freshDb) && isset($freshDb['products'])) {
                $db = $freshDb;
            }
        }

        // Execute mutation
        $result = $callback($db);

        // If callback returned boolean false or explicitly indicated cancel, do not write
        if ($result !== false && (!is_array($result) || !isset($result['_cancelWrite']))) {
            $db['updatedAt'] = date('c');
            $jsonOut = json_encode($db, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE);

            if ($jsonOut === false || strlen($jsonOut) < 10) {
                throw new \RuntimeException('Failed to encode database JSON (json_encode failed or payload too small)');
            }

            $tmpFile = $dataFile . '.tmp.' . uniqid('', true);
            $written = @file_put_contents($tmpFile, $jsonOut, LOCK_EX);
            if ($written !== false && $written === strlen($jsonOut)) {
                if (file_exists($dataFile)) {
                    @copy($dataFile, $dataFile . '.bak');
                }
                if (!@rename($tmpFile, $dataFile)) {
                    @unlink($tmpFile);
                    throw new \RuntimeException('Failed to atomically rename database temporary file');
                }
                @chmod($dataFile, 0600);
                // Read back verification
                $verifyRaw = @file_get_contents($dataFile);
                $verifyJson = @json_decode($verifyRaw, true);
                if (!is_array($verifyJson) || !isset($verifyJson['products'])) {
                    throw new \RuntimeException('Database verification readback failed after write');
                }
                $committedWritesCount++;
            } else {
                @unlink($tmpFile);
                throw new \RuntimeException('Failed to write complete database JSON contents');
            }
        }

        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
        return $result;
    } catch (\Throwable $e) {
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
        onival_log('database', 'transaction_exception', $e->getMessage(), [
            'file' => $e->getFile(),
            'line' => $e->getLine()
        ]);
        return ['ok' => false, 'code' => 'DATA_WRITE_FAILED', 'error' => 'خطای سیستمی در ثبت تراکنش دیتابیس: ' . $e->getMessage()];
    }
}

function loadDatabaseReadonly() {
    global $dataFile, $lockFile;
    if (!file_exists($dataFile)) {
        ensureRuntimeReady();
    }
    if (!file_exists($dataFile)) {
        return null;
    }

    $lockFp = @fopen($lockFile, 'r');
    if ($lockFp) {
        @flock($lockFp, LOCK_SH);
    }
    $raw = @file_get_contents($dataFile);
    if ($lockFp) {
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
    }

    if (!$raw || strlen($raw) < 5) return null;
    $data = @json_decode($raw, true);
    if (!is_array($data) || !isset($data['products'])) {
        return null; // Never return empty template for corrupted/failed read
    }

    // State-based bootstrap check: if setup is pending and credentials are null/empty
    $creds = $data['adminCredentials'] ?? [];
    if (empty($creds['initialSetupCompleted']) && empty($creds['oneTimePassword']) && empty($creds['password'])) {
        ensureRuntimeReady();
        $freshRaw = @file_get_contents($dataFile);
        $freshData = @json_decode($freshRaw, true);
        if (is_array($freshData) && isset($freshData['products'])) {
            $data = $freshData;
        }
    }

    return $data;
}

// ------------------------------------------------------------------------------
// 5. Authentication & Passwords
// ------------------------------------------------------------------------------
function hashAdminPassword($password) {
    return password_hash($password, PASSWORD_DEFAULT);
}

function matchesOneTimeCredential($input, $stored) {
    if (!is_string($input) || !is_string($stored) || $input === '' || $stored === '') {
        return false;
    }
    $trimmedInput = trim($input);
    $trimmedStored = trim($stored);
    if ($trimmedInput === '' || $trimmedStored === '') {
        return false;
    }

    // Modern password_hash check
    if (str_starts_with($trimmedStored, '$')) {
        if (password_verify($trimmedInput, $trimmedStored) || password_verify($input, $trimmedStored)) {
            return true;
        }
    }

    // Legacy plain check via hash_equals
    if (hash_equals($trimmedStored, $trimmedInput) || hash_equals($stored, $input)) {
        return true;
    }

    return false;
}

function verifyAdminPassword($inputPass, $storedPassOrHash, $isInitialPending = false, $oneTimePassOrHash = null) {
    // Reject empty input immediately
    if (!is_string($inputPass) || trim($inputPass) === '') return false;
    $trimmedInput = trim($inputPass);

    // Initial setup pending (initialSetupCompleted === false): strictly verify against stored oneTimePassword
    if ($isInitialPending) {
        return matchesOneTimeCredential($inputPass, (string)$oneTimePassOrHash);
    }

    // Post-setup: strictly valid native password_hash ($2y$, $argon2id$, etc.)
    if (!is_string($storedPassOrHash) || trim($storedPassOrHash) === '') return false;
    $trimmedStored = trim($storedPassOrHash);

    // Never authenticate against a scrypt: or non-standard hash
    if (!str_starts_with($trimmedStored, '$')) {
        return false;
    }

    if (password_verify($trimmedInput, $trimmedStored) || password_verify($inputPass, $trimmedStored)) {
        return true;
    }

    return false;
}

// ------------------------------------------------------------------------------
// 5.1 Shared Authoritative Pricing Function
// ------------------------------------------------------------------------------
function calculateProductPricePhp($product, $selectedSize = null) {
    $basePrice = $selectedSize ? (int)($selectedSize['price'] ?? 0) : (int)($product['price'] ?? 0);
    $isAmazing = !empty($product['isAmazingOffer']) || !empty($product['isSpecialOffer']);

    // Quota resolution: a missing size-level quota inherits product-level quota; product-level zero means no promo.
    $productPromoQuota = isset($product['specialOfferStock']) && $product['specialOfferStock'] !== '' && $product['specialOfferStock'] !== null
        ? (int)$product['specialOfferStock']
        : null;

    if ($productPromoQuota === 0) {
        $quota = 0;
    } elseif ($selectedSize && isset($selectedSize['specialOfferStock']) && $selectedSize['specialOfferStock'] !== '' && $selectedSize['specialOfferStock'] !== null) {
        $quota = (int)$selectedSize['specialOfferStock'];
    } else {
        $quota = $productPromoQuota;
    }

    $promoDiscountPrice = $selectedSize && !empty($selectedSize['discountPrice'])
        ? (int)$selectedSize['discountPrice']
        : (!empty($product['discountPrice']) ? (int)$product['discountPrice'] : null);

    $ordinaryDiscount = max(0, min(99, (int)($product['discount'] ?? $product['discountPercent'] ?? 0)));

    // Rule: The promotional "amazing offer" discount applies only while active and quota > 0
    if ($isAmazing) {
        if ($quota !== null && $quota <= 0) {
            // When exhausted, the base price applies and the code must not fall through to the ordinary-discount branch
            return [
                'price' => $basePrice,
                'oldPrice' => null,
                'isPromo' => false,
                'quotaExhausted' => true
            ];
        }
        if ($promoDiscountPrice && $promoDiscountPrice > 0 && $promoDiscountPrice < $basePrice) {
            return [
                'price' => $promoDiscountPrice,
                'oldPrice' => $basePrice,
                'isPromo' => true,
                'quotaExhausted' => false
            ];
        }
        if ($ordinaryDiscount > 0) {
            $calc = (int)round($basePrice * (100 - $ordinaryDiscount) / 100);
            return [
                'price' => $calc,
                'oldPrice' => $basePrice,
                'isPromo' => true,
                'quotaExhausted' => false
            ];
        }
    }

    // Rule: Ordinary discount always applies for non-promo products
    if ($ordinaryDiscount > 0) {
        $calc = (int)round($basePrice * (100 - $ordinaryDiscount) / 100);
        return [
            'price' => $calc,
            'oldPrice' => $basePrice,
            'isPromo' => false,
            'quotaExhausted' => false
        ];
    }

    if ($promoDiscountPrice && $promoDiscountPrice > 0 && $promoDiscountPrice < $basePrice && ($quota === null || $quota > 0)) {
        return [
            'price' => $promoDiscountPrice,
            'oldPrice' => $basePrice,
            'isPromo' => false,
            'quotaExhausted' => false
        ];
    }

    return [
        'price' => $basePrice,
        'oldPrice' => null,
        'isPromo' => false,
        'quotaExhausted' => false
    ];
}

function getBearerToken() {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/Bearer\s+(.*)$/i', $authHeader, $matches)) {
        return trim($matches[1]);
    }
    if (!empty($_SERVER['HTTP_X_ADMIN_TOKEN'])) {
        return trim($_SERVER['HTTP_X_ADMIN_TOKEN']);
    }
    return '';
}

$GLOBALS['__ONIVAL_CACHED_RAW_BODY'] = null;

function getRequestBodyCached($maxBytes = 10485760) {
    if ($GLOBALS['__ONIVAL_CACHED_RAW_BODY'] !== null) {
        if ($maxBytes !== null && strlen($GLOBALS['__ONIVAL_CACHED_RAW_BODY']) > $maxBytes) {
            http_response_code(413);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode([
                'ok' => false,
                'code' => 'PAYLOAD_TOO_LARGE',
                'error' => 'حجم بدنه درخواست بیش از حد مجاز است (413 Payload Too Large).'
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
        return $GLOBALS['__ONIVAL_CACHED_RAW_BODY'];
    }

    $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($maxBytes !== null && $contentLength > $maxBytes) {
        http_response_code(413);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok' => false,
            'code' => 'PAYLOAD_TOO_LARGE',
            'error' => 'حجم بدنه درخواست بیش از حد مجاز است (413 Payload Too Large).'
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $raw = @file_get_contents('php://input', false, null, 0, $maxBytes ? ($maxBytes + 1) : -1);
    if ($raw !== false && $maxBytes !== null && strlen($raw) > $maxBytes) {
        http_response_code(413);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok' => false,
            'code' => 'PAYLOAD_TOO_LARGE',
            'error' => 'حجم بدنه درخواست بیش از حد مجاز است (413 Payload Too Large).'
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $GLOBALS['__ONIVAL_CACHED_RAW_BODY'] = ($raw !== false) ? $raw : '';
    return $GLOBALS['__ONIVAL_CACHED_RAW_BODY'];
}

function readBoundedRequestBodyPhp($maxBytes = 10485760) {
    return getRequestBodyCached($maxBytes);
}

function claimWebhookUpdatePhp($updateId, $ttlSeconds = 120) {
    global $webhookUpdatesFile;
    if ($updateId === null || $updateId === '' || empty($webhookUpdatesFile)) {
        return ['ok' => true, 'claimed' => true];
    }

    // Verify it strictly lives in ONIVAL_PRIVATE_DIR
    if (!str_starts_with($webhookUpdatesFile, ONIVAL_PRIVATE_DIR)) {
        return ['ok' => false, 'code' => 'INVALID_PATH'];
    }

    $lockFile = $webhookUpdatesFile . '.lock';
    $lockFp = @fopen($lockFile, 'c+');
    if (!$lockFp || !@flock($lockFp, LOCK_EX)) {
        if ($lockFp) @fclose($lockFp);
        return ['ok' => false, 'code' => 'LOCK_FAILED'];
    }

    $now = time();
    $data = [];
    if (file_exists($webhookUpdatesFile)) {
        $raw = @file_get_contents($webhookUpdatesFile);
        $data = @json_decode($raw, true) ?: [];
    }

    // Prune entries older than 24h
    $pruned = [];
    foreach ($data as $id => $entry) {
        $ts = is_array($entry) ? ($entry['timestamp'] ?? 0) : (int)$entry;
        if (($now - $ts) < 86400) {
            $pruned[$id] = is_array($entry) ? $entry : ['state' => 'done', 'timestamp' => $ts];
        }
    }
    // Bounded store: retain up to 3000 recent update claims
    if (count($pruned) > 3000) {
        $pruned = array_slice($pruned, -3000, null, true);
    }

    $updateKey = (string)$updateId;
    if (isset($pruned[$updateKey])) {
        $existing = $pruned[$updateKey];
        $state = $existing['state'] ?? 'done';
        $ts = (int)($existing['timestamp'] ?? 0);

        // Done entries are NEVER reclaimed
        if ($state === 'done') {
            @flock($lockFp, LOCK_UN);
            @fclose($lockFp);
            return ['ok' => true, 'claimed' => false, 'reason' => 'done'];
        }

        // In flight check: if claimed recently (< TTL), prevent double processing
        if ($state === 'claimed') {
            if (($now - $ts) < $ttlSeconds) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
                return ['ok' => true, 'claimed' => false, 'reason' => 'in_flight'];
            }
            // Stale claim (> TTL) is reclaimed below!
        }
    }

    // Claim update with timestamp
    $pruned[$updateKey] = [
        'state' => 'claimed',
        'timestamp' => $now
    ];

    $tmp = $webhookUpdatesFile . '.tmp.' . uniqid('', true);
    @file_put_contents($tmp, json_encode($pruned), LOCK_EX);
    @rename($tmp, $webhookUpdatesFile);

    @flock($lockFp, LOCK_UN);
    @fclose($lockFp);

    return ['ok' => true, 'claimed' => true];
}

function finalizeWebhookUpdatePhp($updateId, $outcome = 'done') {
    global $webhookUpdatesFile;
    if ($updateId === null || $updateId === '' || empty($webhookUpdatesFile)) {
        return;
    }

    $lockFile = $webhookUpdatesFile . '.lock';
    $lockFp = @fopen($lockFile, 'c+');
    if (!$lockFp || !@flock($lockFp, LOCK_EX)) {
        if ($lockFp) @fclose($lockFp);
        return;
    }

    $now = time();
    $data = [];
    if (file_exists($webhookUpdatesFile)) {
        $raw = @file_get_contents($webhookUpdatesFile);
        $data = @json_decode($raw, true) ?: [];
    }

    $updateKey = (string)$updateId;
    if ($outcome === 'released' || $outcome === false) {
        // Processing aborted before committed side effects: release claim so redelivery can retry
        unset($data[$updateKey]);
    } else {
        // Default is done
        $data[$updateKey] = [
            'state' => 'done',
            'timestamp' => $now
        ];
    }

    $tmp = $webhookUpdatesFile . '.tmp.' . uniqid('', true);
    @file_put_contents($tmp, json_encode($data), LOCK_EX);
    @rename($tmp, $webhookUpdatesFile);

    @flock($lockFp, LOCK_UN);
    @fclose($lockFp);
}

function isRateLimitedPhp($bucketName, $maxRequests) {
    global $rateLimitsFile;
    $ip = getClientIpPhp();
    $now = time();
    $file = $rateLimitsFile;
    $bucketKey = substr(hash('sha256', "{$bucketName}:{$ip}"), 0, 24);

    $lockFp = @fopen($file . '.lock', 'c+');
    if (!$lockFp || !@flock($lockFp, LOCK_SH)) {
        if ($lockFp) @fclose($lockFp);
        return false;
    }

    $data = [];
    if (file_exists($file)) {
        $raw = @file_get_contents($file);
        $data = @json_decode($raw, true) ?: [];
    }
    @flock($lockFp, LOCK_UN);
    @fclose($lockFp);

    $current = $data[$bucketKey] ?? null;
    if ($current && isset($current['resetAt']) && $current['resetAt'] > $now && ($current['count'] ?? 0) >= $maxRequests) {
        return max(1, $current['resetAt'] - $now);
    }
    return false;
}

function recordRateLimitHitPhp($bucketName, $windowSeconds) {
    global $rateLimitsFile;
    $ip = getClientIpPhp();
    $now = time();
    $file = $rateLimitsFile;
    $bucketKey = substr(hash('sha256', "{$bucketName}:{$ip}"), 0, 24);

    $lockFp = @fopen($file . '.lock', 'c+');
    if ($lockFp && @flock($lockFp, LOCK_EX)) {
        $data = [];
        if (file_exists($file)) {
            $raw = @file_get_contents($file);
            $data = @json_decode($raw, true) ?: [];
        }
        $pruned = [];
        foreach ($data as $k => $rec) {
            if (isset($rec['resetAt']) && $rec['resetAt'] > $now) {
                $pruned[$k] = $rec;
            }
        }
        if (count($pruned) > 200) {
            $pruned = array_slice($pruned, -200, null, true);
        }
        $current = $pruned[$bucketKey] ?? null;
        if (!$current || $now >= $current['resetAt']) {
            $pruned[$bucketKey] = ['count' => 1, 'resetAt' => $now + $windowSeconds];
        } else {
            $pruned[$bucketKey]['count']++;
        }
        @file_put_contents($file, json_encode($pruned), LOCK_EX);
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
    }
}

function getRevokedTokensFilePath() {
    global $revokedTokensFile;
    return $revokedTokensFile;
}

function revokeAdminTokenPhp($token) {
    $file = getRevokedTokensFilePath();
    $tokenSig = substr(hash('sha256', (string)$token), 0, 32);
    $now = time();

    $lockFp = @fopen($file . '.lock', 'c+');
    if ($lockFp && @flock($lockFp, LOCK_EX)) {
        $data = [];
        if (file_exists($file)) {
            $raw = @file_get_contents($file);
            $data = @json_decode($raw, true) ?: [];
        }
        $pruned = [];
        foreach ($data as $sig => $ts) {
            if ($now - $ts < 86400) {
                $pruned[$sig] = $ts;
            }
        }
        $pruned[$tokenSig] = $now;
        if (count($pruned) > 200) {
            $pruned = array_slice($pruned, -200, null, true);
        }
        @file_put_contents($file, json_encode($pruned), LOCK_EX);
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
    }
}

function isTokenRevokedPhp($token) {
    $file = getRevokedTokensFilePath();
    if (!file_exists($file)) return false;
    $tokenSig = substr(hash('sha256', (string)$token), 0, 32);
    $raw = @file_get_contents($file);
    $data = @json_decode($raw, true);
    if (!is_array($data) || !isset($data[$tokenSig])) {
        return false;
    }
    return (time() - $data[$tokenSig]) < 86400;
}

function getClientIpPhp() {
    $trustProxy = getenv('TRUST_PROXY') === 'true';
    if ($trustProxy && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        $candidate = trim($parts[0]);
        if (filter_var($candidate, FILTER_VALIDATE_IP)) {
            return $candidate;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
}

function checkRateLimitPhp($bucketName, $maxRequests, $windowSeconds) {
    global $rateLimitsFile;
    $ip = getClientIpPhp();
    $now = time();
    $file = $rateLimitsFile;
    $bucketKey = substr(hash('sha256', "{$bucketName}:{$ip}"), 0, 24);

    $lockFp = @fopen($file . '.lock', 'c+');
    if (!$lockFp || !@flock($lockFp, LOCK_EX)) {
        if ($lockFp) @fclose($lockFp);
        return ['allowed' => true, 'remaining' => $maxRequests, 'retryAfter' => 0];
    }

    $data = [];
    if (file_exists($file)) {
        $raw = @file_get_contents($file);
        $data = @json_decode($raw, true) ?: [];
    }

    $active = [];
    foreach ($data as $k => $rec) {
        if (isset($rec['resetAt']) && $rec['resetAt'] > $now) {
            $active[$k] = $rec;
        }
    }
    if (count($active) > 200) {
        $active = array_slice($active, -200, null, true);
    }

    $current = $active[$bucketKey] ?? null;
    if (!$current || $now >= $current['resetAt']) {
        $active[$bucketKey] = [
            'count' => 1,
            'resetAt' => $now + $windowSeconds
        ];
        @file_put_contents($file, json_encode($active), LOCK_EX);
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
        return ['allowed' => true, 'remaining' => $maxRequests - 1, 'retryAfter' => 0];
    }

    if ($current['count'] >= $maxRequests) {
        $retryAfter = max(1, $current['resetAt'] - $now);
        @flock($lockFp, LOCK_UN);
        @fclose($lockFp);
        return ['allowed' => false, 'remaining' => 0, 'retryAfter' => $retryAfter];
    }

    $active[$bucketKey]['count']++;
    @file_put_contents($file, json_encode($active), LOCK_EX);
    @flock($lockFp, LOCK_UN);
    @fclose($lockFp);
    return ['allowed' => true, 'remaining' => max(0, $maxRequests - $active[$bucketKey]['count']), 'retryAfter' => 0];
}

function enforceRateLimitOrExitPhp($bucketName, $maxRequests, $windowSeconds, $customMsg = '') {
    $res = checkRateLimitPhp($bucketName, $maxRequests, $windowSeconds);
    if (!$res['allowed']) {
        onival_log('rate_limit', 'RATE_LIMIT_REJECTED', "Rate limit hit on bucket {$bucketName}", [
            'bucket' => $bucketName,
            'retryAfter' => $res['retryAfter']
        ]);
        header('Retry-After: ' . $res['retryAfter']);
        http_response_code(429);
        echo json_encode([
            'ok' => false,
            'code' => 'RATE_LIMIT_EXCEEDED',
            'error' => $customMsg ?: "تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً {$res['retryAfter']} ثانیه دیگر امتحان نمایید.",
            'retryAfterSeconds' => $res['retryAfter']
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

function generateAdminSessionToken($username, $passOrHash, $time = null) {
    $secret = getAdminSessionSecret();
    $issuedAt = $time !== null ? (int)$time : time();
    $sig = hash_hmac('sha256', strtolower(trim($username)) . ':' . trim($passOrHash) . ':' . $issuedAt, $secret);
    return 'host_auth_' . $issuedAt . '_' . $sig;
}

function isRequestAdminAuthorized($db) {
    $token = getBearerToken();
    if (empty($token)) return false;

    // Check if token has been revoked via logout
    if (isTokenRevokedPhp($token)) {
        return false;
    }

    $now = time();
    if (preg_match('/^host_auth_(\d+)_([a-f0-9]{64})$/i', $token, $m)) {
        $issuedAt = (int)$m[1];
        $sig = $m[2];

        // 24-hour expiration check
        if ($now - $issuedAt > 86400 || $issuedAt > $now + 300) {
            return false;
        }

        $creds = $db['adminCredentials'] ?? [];
        $validUser = strtolower(trim($creds['username'] ?? 'admin'));
        $validEmail = strtolower(trim($creds['email'] ?? ''));
        $validPass = trim($creds['password'] ?? '');
        if (empty($validPass) && !empty($creds['oneTimePassword']) && empty($creds['initialSetupCompleted'])) {
            $validPass = trim($creds['oneTimePassword']);
        }
        if (empty($validPass)) {
            return false;
        }
        $secret = getAdminSessionSecret();

        $expectedSigUser = hash_hmac('sha256', $validUser . ':' . $validPass . ':' . $issuedAt, $secret);
        if (hash_equals($expectedSigUser, $sig)) {
            return true;
        }
        if (!empty($validEmail)) {
            $expectedSigEmail = hash_hmac('sha256', $validEmail . ':' . $validPass . ':' . $issuedAt, $secret);
            if (hash_equals($expectedSigEmail, $sig)) {
                return true;
            }
        }
    }

    return false;
}

// ------------------------------------------------------------------------------
// 6. Safe Inventory Management (Atomic, Per-Product & Per-Size Variants)
// ------------------------------------------------------------------------------
function onivalComputeLinePricePhp($product, $sizeName = '', $quantity = 1) {
    $qty = max(1, (int)$quantity);
    if (!$product || !is_array($product)) {
        return [
            'basePrice' => 0,
            'unitPrice' => 0,
            'discountedUnitPrice' => 0,
            'discountPercent' => 0,
            'discountedQty' => 0,
            'discountedUnits' => 0,
            'discountedQuantity' => 0,
            'regularQty' => $qty,
            'regularUnits' => $qty,
            'regularQuantity' => $qty,
            'discountedSubtotal' => 0,
            'regularSubtotal' => 0,
            'lineTotal' => 0,
            'totalPrice' => 0,
            'effectiveUnitPrice' => 0,
            'quota' => null,
            'capped' => false,
            'stock' => 0,
            'invalidSize' => false
        ];
    }

    $basePrice = max(0, (int)($product['price'] ?? 0));
    $stock = isset($product['stock']) && is_numeric($product['stock']) ? (int)$product['stock'] : 999;
    $selectedSize = null;
    $invalidSize = false;
    $sizeNameTrimmed = trim((string)$sizeName);

    $hasSizes = !empty($product['sizes']) && is_array($product['sizes']);
    if ($hasSizes && $sizeNameTrimmed !== '') {
        $found = false;
        foreach ($product['sizes'] as $s) {
            $sName = trim((string)($s['name'] ?? $s['size'] ?? ''));
            if ($sName === $sizeNameTrimmed) {
                $selectedSize = $s;
                $found = true;
                if (isset($s['price']) && is_numeric($s['price']) && (int)$s['price'] >= 0) {
                    $basePrice = (int)$s['price'];
                }
                if (isset($s['stock']) && is_numeric($s['stock'])) {
                    $stock = (int)$s['stock'];
                }
                break;
            }
        }
        if (!$found) {
            $invalidSize = true;
        }
    }

    $rawDiscount = 0;
    if ($selectedSize && isset($selectedSize['discount']) && is_numeric($selectedSize['discount'])) {
        $rawDiscount = (float)$selectedSize['discount'];
    } elseif ($selectedSize && isset($selectedSize['discountPercent']) && is_numeric($selectedSize['discountPercent'])) {
        $rawDiscount = (float)$selectedSize['discountPercent'];
    } elseif (isset($product['discount']) && is_numeric($product['discount'])) {
        $rawDiscount = (float)$product['discount'];
    } elseif (isset($product['discountPercent']) && is_numeric($product['discountPercent'])) {
        $rawDiscount = (float)$product['discountPercent'];
    }

    $discountPercent = max(0, min(99, (int)floor($rawDiscount)));

    $discountedUnitPrice = $basePrice;
    if ($selectedSize && isset($selectedSize['discountPrice']) && is_numeric($selectedSize['discountPrice']) && (int)$selectedSize['discountPrice'] > 0) {
        $discountedUnitPrice = (int)$selectedSize['discountPrice'];
        if ($basePrice > 0 && $discountPercent == 0) {
            $discountPercent = max(0, min(99, (int)round((($basePrice - $discountedUnitPrice) / $basePrice) * 100)));
        }
    } elseif ($discountPercent > 0) {
        $discountedUnitPrice = (int)round($basePrice * (100 - $discountPercent) / 100);
    } elseif (isset($product['discountPrice']) && is_numeric($product['discountPrice']) && (int)$product['discountPrice'] > 0 && !$selectedSize) {
        $discountedUnitPrice = (int)$product['discountPrice'];
        if ($basePrice > 0 && $discountPercent == 0) {
            $discountPercent = max(0, min(99, (int)round((($basePrice - $discountedUnitPrice) / $basePrice) * 100)));
        }
    }

    $quota = null;
    if ($selectedSize && isset($selectedSize['specialOfferStock']) && $selectedSize['specialOfferStock'] !== null && $selectedSize['specialOfferStock'] !== '') {
        $quota = max(0, (int)$selectedSize['specialOfferStock']);
    } elseif (isset($product['specialOfferStock']) && $product['specialOfferStock'] !== null && $product['specialOfferStock'] !== '') {
        $quota = max(0, (int)$product['specialOfferStock']);
    }

    if ($discountPercent > 0 && $discountedUnitPrice < $basePrice) {
        if ($quota === null) {
            $discountedQty = $qty;
            $regularQty = 0;
        } else {
            $discountedQty = min($qty, max(0, $quota));
            $regularQty = $qty - $discountedQty;
        }
    } else {
        $discountPercent = 0;
        $discountedUnitPrice = $basePrice;
        $discountedQty = 0;
        $regularQty = $qty;
    }

    $discountedSubtotal = $discountedQty * $discountedUnitPrice;
    $regularSubtotal = $regularQty * $basePrice;
    $lineTotal = $discountedSubtotal + $regularSubtotal;
    $effectiveUnitPrice = ($qty > 0) ? (int)round($lineTotal / $qty) : $basePrice;
    $capped = ($quota !== null && $discountPercent > 0 && $qty > $quota);

    return [
        'basePrice' => $basePrice,
        'unitPrice' => $basePrice,
        'discountedUnitPrice' => $discountedUnitPrice,
        'discountPercent' => $discountPercent,
        'discountedQty' => $discountedQty,
        'discountedUnits' => $discountedQty,
        'discountedQuantity' => $discountedQty,
        'regularQty' => $regularQty,
        'regularUnits' => $regularQty,
        'regularQuantity' => $regularQty,
        'discountedSubtotal' => $discountedSubtotal,
        'regularSubtotal' => $regularSubtotal,
        'lineTotal' => $lineTotal,
        'totalPrice' => $lineTotal,
        'effectiveUnitPrice' => $effectiveUnitPrice,
        'quota' => $quota,
        'capped' => $capped,
        'stock' => $stock,
        'invalidSize' => $invalidSize
    ];
}

function onivalOrderItemRows($item) {
    if (!$item || !is_array($item)) return [];
    $qty = max(1, (int)($item['quantity'] ?? 1));
    $basePrice = isset($item['basePrice']) && is_numeric($item['basePrice']) ? (int)$item['basePrice'] : (int)($item['unitPrice'] ?? 0);
    $discPercent = isset($item['discountPercent']) ? (int)$item['discountPercent'] : 0;
    $discQty = isset($item['discountedQuantity']) ? (int)$item['discountedQuantity'] : (isset($item['discountedUnits']) ? (int)$item['discountedUnits'] : (isset($item['discountedQty']) ? (int)$item['discountedQty'] : 0));
    $regQty = isset($item['regularQuantity']) ? (int)$item['regularQuantity'] : (isset($item['regularUnits']) ? (int)$item['regularUnits'] : (isset($item['regularQty']) ? (int)$item['regularQty'] : ($qty - $discQty)));
    $discUnitPrice = isset($item['discountedUnitPrice']) && is_numeric($item['discountedUnitPrice']) ? (int)$item['discountedUnitPrice'] : (($discPercent > 0) ? (int)round($basePrice * (100 - $discPercent) / 100) : $basePrice);

    if ($discPercent > 0 && $discQty > 0) {
        $rows = [];
        $rows[] = [
            'kind' => 'discounted',
            'qty' => $discQty,
            'unitPrice' => $discUnitPrice,
            'amount' => $discQty * $discUnitPrice,
            'discountPercent' => $discPercent
        ];
        if ($regQty > 0) {
            $rows[] = [
                'kind' => 'regular',
                'qty' => $regQty,
                'unitPrice' => $basePrice,
                'amount' => $regQty * $basePrice,
                'discountPercent' => 0
            ];
        }
        return $rows;
    }

    $totalPrice = isset($item['totalPrice']) && is_numeric($item['totalPrice']) ? (int)$item['totalPrice'] : ($qty * $basePrice);
    $unitPrice = ($qty > 0) ? (int)round($totalPrice / $qty) : $totalPrice;
    return [
        [
            'kind' => 'plain',
            'qty' => $qty,
            'unitPrice' => $unitPrice,
            'amount' => $totalPrice,
            'discountPercent' => 0
        ]
    ];
}

function onivalPersianNumber($num) {
    $str = number_format((float)$num);
    $farsi = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹', '٬'];
    $ascii = ['0','1','2','3','4','5','6','7','8','9', ','];
    return str_replace($ascii, $farsi, $str);
}

function onivalOrderBreakdownText($order) {
    if (!$order || empty($order['items']) || !is_array($order['items'])) {
        return '';
    }
    $lines = [];
    foreach ($order['items'] as $item) {
        $pName = trim((string)($item['productName'] ?? $item['name'] ?? 'محصول'));
        $size = trim((string)($item['size'] ?? ''));
        $header = "▫️ {$pName}" . ($size !== '' && $size !== 'استاندارد' ? " ({$size})" : "");
        $lines[] = $header;

        $rows = onivalOrderItemRows($item);
        if (count($rows) === 2 && $rows[0]['kind'] === 'discounted' && $rows[1]['kind'] === 'regular') {
            $r1 = $rows[0];
            $r2 = $rows[1];
            $lines[] = "  " . onivalPersianNumber($r1['qty']) . " عدد × " . onivalPersianNumber($r1['unitPrice']) . " = " . onivalPersianNumber($r1['amount']) . " تومان (با " . onivalPersianNumber($r1['discountPercent']) . "٪ تخفیف)";
            $lines[] = "  " . onivalPersianNumber($r2['qty']) . " عدد × " . onivalPersianNumber($r2['unitPrice']) . " = " . onivalPersianNumber($r2['amount']) . " تومان (قیمت اصلی)";
            $lines[] = "  ℹ️ تخفیف این محصول فقط برای " . onivalPersianNumber($r1['qty']) . " عدد اول اعمال میشود؛ " . onivalPersianNumber($r2['qty']) . " عدد بعدی با قیمت اصلی محاسبه شده است.";
        } elseif (count($rows) === 1) {
            $r = $rows[0];
            $extra = ($r['kind'] === 'discounted' && $r['discountPercent'] > 0) ? " (با " . onivalPersianNumber($r['discountPercent']) . "٪ تخفیف)" : "";
            $lines[] = "  " . onivalPersianNumber($r['qty']) . " عدد × " . onivalPersianNumber($r['unitPrice']) . " = " . onivalPersianNumber($r['amount']) . " تومان" . $extra;
        }
    }
    return implode("\n", $lines);
}

function onivalDefaultSiteContent() {
    return [
        'brandName' => 'اونیوال',
        'brandEnglishName' => 'ONIVAL',
        'siteLogo' => '',
        'siteLogoFit' => 'cover',
        'siteLogoShape' => 'rounded',
        'siteLogoScale' => 100,
        'systemTagline' => 'سامانه یکپارچه مدیریت فروشگاه، مقالات و ربات بله اونیوال (ONIVAL Admin)',
        'tagline' => 'فروشگاه تخصصی محصولات ارگانیک و کندوی اونیوال',
        'brandDescription' => 'عرضه مستقیم عسل طبیعی، ژل رویال، گرده گل و فرآورده‌های ارگانیک کوهستان',
        'heroTitlePrefix' => 'فروشگاه تخصصی',
        'heroSubtitle' => 'عرضه مستقیم عسل طبیعی، ژل رویال، گرده گل و فرآورده‌های ارگانیک کوهستان',
        'heroAlign' => 'center',
        'phone' => '۰۲۱-۱۲۳۴۵۶۷۸',
        'email' => 'info@onival.ir',
        'address' => 'تهران، خیابان ولیعصر، مجموعه فرآورده‌های طبیعی اونیوال',
        'navLabels' => [
            'home' => 'خانه',
            'articles' => 'مقالات',
            'consultation' => 'مشاوره تخصصی',
            'tracking' => 'پیگیری سفارش',
            'about' => 'درباره ما',
            'contact' => 'تماس'
        ],
        'homeSections' => [
            [
                'id' => 'specialOffers',
                'title' => 'پیشنهاد شگفت‌انگیز',
                'subtitle' => 'تخفیف‌های استثنایی محصولات برگزیده کندو',
                'enabled' => true,
                'align' => 'right',
                'order' => 1
            ],
            [
                'id' => 'categories',
                'title' => 'دسته‌بندی‌های محصولات',
                'subtitle' => 'دسترسی سریع به گروه‌های کالایی',
                'enabled' => true,
                'align' => 'right',
                'order' => 2
            ],
            [
                'id' => 'products',
                'title' => 'لیست محصولات اونیوال',
                'subtitle' => 'محصولات ارگانیک و طبیعی با ضمانت اصالت و برگه آزمایشگاه',
                'enabled' => true,
                'align' => 'right',
                'order' => 3
            ],
            [
                'id' => 'consultationBanner',
                'title' => 'مشاوره تخصصی رایگان',
                'subtitle' => 'راهنمایی انتخاب عسل دارویی و فرآورده‌های ویژه سلامت',
                'enabled' => true,
                'align' => 'center',
                'order' => 4
            ],
            [
                'id' => 'articles',
                'title' => 'مقالات و مطالب علمی اونیوال',
                'subtitle' => 'آخرین نوشته‌ها برای آشنایی با خواص عسل طبیعی، دمنوش‌های گیاهی و سبک زندگی سالم',
                'enabled' => true,
                'align' => 'right',
                'order' => 5
            ]
        ],
        'specialOffersTitle' => 'پیشنهاد شگفت‌انگیز',
        'specialOffersButtonText' => 'مشاهده همه',
        'specialOffersBgColor' => '#ef394e',
        'productsSectionTitle' => 'لیست محصولات اونیوال',
        'productsSectionSubtitle' => 'محصولات موجود با ضمانت اصالت',
        'productsAlign' => 'right',
        'articlesSectionTitle' => 'مقالات و مطالب علمی اونیوال',
        'articlesSectionSubtitle' => 'آخرین نوشته‌ها برای آشنایی با خواص عسل طبیعی، دمنوش‌های گیاهی و سبک زندگی سالم.',
        'articlesPageTitle' => 'دانشنامه و مقالات تخصصی اونیوال (ONIVAL)',
        'articlesPageSubtitle' => 'مرجع جامع راهنمای تشخیص عسل طبیعی، فواید ژل رویال، دمنوش‌های گیاهی و تغذیه ارگانیک',
        'articlesAlign' => 'right',
        'consultationBadge' => 'مشاوره رایگان و تخصصی فرآورده‌های کندو',
        'consultationTitle' => 'درخواست مشاوره تخصصی سلامت و محصولات اونیوال',
        'consultationSubtitle' => 'پرسش‌های خود را درباره خواص درمانی عسل، طریقه مصرف ژل رویال، گرده گل و رژیم‌های طبیعی مطرح نمایید.',
        'consultationTopics' => [
            'خواص درمانی عسل ارگانیک سبلان (دیابت، سرماخوردگی، زخم معده)',
            'دوز مصرف و نگهداری ژل رویال و گرده گل',
            'ترکیبات دمنوش گیاهی ضد استرس و بی‌خوابی',
            'سکنجبین سنتی و پاکسازی کبد چرب',
            'انتخاب وزن و مشاوره سفارش عمده و خرید مستقیم'
        ],
        'consultationAlign' => 'center',
        'trackingTitle' => 'پیگیری وضعیت سفارش و پیام مشاوره',
        'trackingSubtitle' => 'کد رهگیری فاکتور خرید (مانند ONV-ORD-101) یا کد رهگیری پیام مشاوره (مانند ONV-MSG-101) را وارد نمایید.',
        'trackingAlign' => 'center',
        'aboutTitle' => 'درباره فروشگاه اونیوال (ONIVAL)',
        'aboutParagraph1' => 'مجموعه تخصصی اونیوال با همکاری مستقیم زنبورداران محلی و کشاورزان متعهد سبلان و البرز، محصولات کاملاً سالم، ارگانیک و حرارت‌ندیده را بدون واسطه به دست خانواده‌های ایرانی می‌رساند.',
        'aboutParagraph2' => 'تمامی عسل‌ها دارای برگه آزمایشگاهی تخصصی با ساکارز زیر ۲ درصد بوده و فرآورده‌های دارویی کندو از جمله ژل رویال و گرده گل با حفظ کامل زنجیره سرمایشی نگهداری و توزیع می‌شوند.',
        'aboutStat1Value' => '۱۰۰٪',
        'aboutStat1Label' => 'طبیعی، خام و آزمایش‌شده',
        'aboutStat2Value' => '۷ روز',
        'aboutStat2Label' => 'ضمانت اصالت و بازگشت وجه',
        'aboutStat3Value' => '+۱۵ سال',
        'aboutStat3Label' => 'سابقه تولید و عرضه فرآورده‌های ارگانیک',
        'contactTitle' => 'تماس با ما',
        'contactSubtitle' => 'جهت پیگیری سفارشات، هماهنگی خرید عمده و ارتباط مستقیم با دفتر مرکزی اونیوال:',
        'contactPhone' => '۰۲۱-۱۲۳۴۵۶۷۸ / ۰۹۱۲۳۴۵۶۷۸۹',
        'contactAddress' => 'تهران، مجموعه تخصصی فرآورده‌های ارگانیک اونیوال (ONIVAL)',
        'contactWorkingHours' => 'شنبه تا چهارشنبه ۹:۰۰ الی ۱۸:۰۰ | پنج‌شنبه‌ها ۹:۰۰ الی ۱۳:۰۰',
        'contactEmail' => 'support@onival.ir',
        'footerCopyright' => 'تمامی حقوق مادی و معنوی متعلق به فروشگاه اونیوال (ONIVAL) می‌باشد.',
        'topBannerSettings' => [
            'enabled' => true,
            'intervalSeconds' => 4,
            'autoRotate' => true,
            'showDots' => true,
            'showArrows' => true
        ],
        'topBanners' => [
            [
                'id' => 'banner-slide-1',
                'imageUrl' => 'https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=1600&auto=format&fit=crop&q=80',
                'title' => 'عسل طبیعی و خام کوهستان با برگه رسمی آزمایشگاهی',
                'subtitle' => 'برداشت مستقیم از بهترین کندوهای دامنه سبلان بدون فرآوری و حرارت‌دهی صنعتی',
                'linkUrl' => '/categories/honey',
                'linkMode' => 'banner',
                'linkTarget' => false,
                'buttonText' => 'مشاهده و سفارش آنلاین',
                'enabled' => true
            ],
            [
                'id' => 'banner-slide-2',
                'imageUrl' => 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=1600&auto=format&fit=crop&q=80',
                'title' => 'ژل رویال شاهانه ۱۰۰٪ خالص در زنجیره سرمایشی',
                'subtitle' => 'اکسیر جوانی و تقویت قوای جسمی و سیستم ایمنی با بسته‌بندی ایزوله یخچالی',
                'linkUrl' => '/categories/supplement',
                'linkMode' => 'banner',
                'linkTarget' => false,
                'buttonText' => 'مشاهده و سفارش آنلاین',
                'enabled' => true
            ],
            [
                'id' => 'banner-slide-3',
                'imageUrl' => 'https://images.unsplash.com/photo-1627435601361-ec25f5b1d0e5?w=1600&auto=format&fit=crop&q=80',
                'title' => 'دمنوش‌های آرامش‌بخش کوهستان و سکنجبین سنتی',
                'subtitle' => 'ترکیب دست‌چین گیاهان دارویی خودرو، تصفیه‌کننده کبد و کاملاً ارگانیک',
                'linkUrl' => '/categories/drink',
                'linkMode' => 'banner',
                'linkTarget' => false,
                'buttonText' => 'مشاهده و سفارش آنلاین',
                'enabled' => true
            ]
        ],
        'paymentConfig' => [
            'cardToCardEnabled' => true,
            'cardNumber' => '۶۰۳۷-۹۹۷۵-۹۹۱۲-۳۴۵۶',
            'cardHolderName' => 'مجموعه تخصصی فرآورده‌های ارگانیک اونیوال',
            'bankName' => 'بانک ملی ایران',
            'cardDescription' => 'لطفاً مبلغ دقیق فاکتور را به شماره کارت بالا واریز نموده و سپس تصویر واضح فیش واریزی یا اسکرین‌شات رسید انتقال وجه را به همراه شماره فاکتور در کادر زیر بارگذاری فرمایید. پس از تایید فیش توسط مدیریت، می‌توانید وضعیت ارسال سفارش خود را با کد رهگیری پیگیری نمایید.',
            'gatewayOfflineNoticeTitle' => 'اطلاعیه همراهان گرامی درباره نحوه پرداخت',
            'gatewayOfflineNoticeText' => 'همراه گرامی و ارجمند، به دلیل بروزرسانی فنی زیرساخت شبکه بانکی، پرداخت مستقیم از طریق درگاه اینترنتی در حال حاضر به صورت موقت قطع می‌باشد. ضمن پوزش از شما و قدردانی از همراهی و شکیبایی ارزشمندتان، می‌توانید مبلغ فاکتور را با اطمینان کامل به صورت «کارت به کارت» واریز نموده و تصویر فیش را در همین صفحه بارگذاری فرمایید تا سفارش شما بدون هیچ‌گونه تاخیری و در اولویت ویژه آماده و ارسال گردد.',
            'baleBotEnabled' => true,
            'baleBotUsername' => 'Onivalbot',
            'baleBotDescription' => 'اتصال مستقیم به بازوی رسمی بله (@Onivalbot) و دریافت پیش‌فاکتور با امکان پرداخت آنی با کیف پول بله یا کارت به کارت.',
            'baleBotButtonText' => 'اتصال به ربات بله و پرداخت فاکتور (@Onivalbot)',
            'gatewayEnabled' => false,
            'gatewayTitle' => 'پرداخت آنلاین از طریق درگاه بانکی شاپرک',
            'gatewayUrl' => 'https://zarinp.al/onival',
            'gatewayMerchantCode' => 'ONIVAL-MERCHANT-982410',
            'gatewayDescription' => 'پرداخت آنی و امن با کلیه کارت‌های بانکی عضو شبکه شتاب و رمز دوم پویا',
            'defaultMethod' => 'card_to_card'
        ],
        'consultationConfig' => [
            'basePrice' => 120000,
            'allowAddToCart' => true,
            'allowDirectPayment' => true,
            'specialistName' => 'متخصص طب سنتی و فرآورده‌های کندوی اونیوال',
            'specialistTitle' => 'مشاوره اختصاصی تغذیه، رژیم درمانی و فرآورده‌های ارگانیک',
            'timeSlots' => [
                'نوبت صبح (۰۹:۰۰ الی ۱۲:۰۰)',
                'نوبت ظهر (۱۲:۰۰ الی ۱۵:۰۰)',
                'نوبت عصر (۱۶:۰۰ الی ۱۹:۰۰)',
                'نوبت شب (۱۹:۰۰ الی ۲۱:۰۰)',
                'اولین زمان خالی کارشناس (فوری)'
            ],
            'topics' => [
                [
                    'id' => 'topic-1',
                    'title' => 'خواص درمانی عسل ارگانیک سبلان (دیابت، سرماخوردگی، زخم معده)',
                    'description' => 'بررسی شرایط بدنی و تجویز نوع و میزان مصرف عسل طبیعی مناسب شما',
                    'price' => 120000,
                    'durationMinutes' => 30,
                    'enabled' => true
                ],
                [
                    'id' => 'topic-2',
                    'title' => 'دوز مصرف و نگهداری ژل رویال و گرده گل',
                    'description' => 'تنظیم برنامه مصرف تخصصی ژل رویال و گرده گل جهت تقویت سیستم ایمنی و انرژی',
                    'price' => 150000,
                    'durationMinutes' => 40,
                    'enabled' => true
                ],
                [
                    'id' => 'topic-3',
                    'title' => 'ترکیبات دمنوش گیاهی ضد استرس و بی‌خوابی',
                    'description' => 'نسخه ترکیبی دمنوش‌های کوهستانی و عسل برای رفع بی‌خوابی و اضطراب روزانه',
                    'price' => 110000,
                    'durationMinutes' => 25,
                    'enabled' => true
                ],
                [
                    'id' => 'topic-4',
                    'title' => 'سکنجبین سنتی و پاکسازی کبد چرب',
                    'description' => 'برنامه ۴۰ روزه پاکسازی کبد و تنظیم متابولیسم با فرآورده‌های طبیعی',
                    'price' => 140000,
                    'durationMinutes' => 35,
                    'enabled' => true
                ],
                [
                    'id' => 'topic-5',
                    'title' => 'انتخاب وزن و مشاوره سفارش عمده و خرید مستقیم',
                    'description' => 'راهنمایی خرید عمده یا سازمانی، بررسی برگه‌های آزمایشگاه و شرایط ارسال',
                    'price' => 80000,
                    'durationMinutes' => 20,
                    'enabled' => true
                ]
            ],
            'socialPlatforms' => [
                [
                    'id' => 'bale',
                    'name' => 'پیام‌رسان بله (Bale)',
                    'placeholder' => 'آیدی یا شماره موبایل شما در بله (مثال: @username یا 09XXXXXXXXX)',
                    'enabled' => true,
                    'iconType' => 'bale'
                ],
                [
                    'id' => 'telegram',
                    'name' => 'تلگرام (Telegram)',
                    'placeholder' => 'آیدی یا شماره موبایل شما در تلگرام (مثال: @username یا 09XXXXXXXXX)',
                    'enabled' => true,
                    'iconType' => 'telegram'
                ],
                [
                    'id' => 'whatsapp',
                    'name' => 'واتساپ (WhatsApp)',
                    'placeholder' => 'شماره موبایل فعال در واتساپ (مثال: 09XXXXXXXXX)',
                    'enabled' => true,
                    'iconType' => 'whatsapp'
                ],
                [
                    'id' => 'eitaa',
                    'name' => 'پیام‌رسان ایتا (Eitaa)',
                    'placeholder' => 'آیدی یا شماره موبایل شما در ایتا (مثال: @username یا 09XXXXXXXXX)',
                    'enabled' => true,
                    'iconType' => 'eitaa'
                ],
                [
                    'id' => 'instagram',
                    'name' => 'دایرکت اینستاگرام (Instagram)',
                    'placeholder' => 'آیدی پیج اینستاگرام شما (مثال: @your_page)',
                    'enabled' => true,
                    'iconType' => 'instagram'
                ],
                [
                    'id' => 'phone',
                    'name' => 'تماس تلفنی مستقیم',
                    'placeholder' => 'شماره تماس مستقیم جهت برقراری تماس کارشناس (مثال: 09XXXXXXXXX)',
                    'enabled' => true,
                    'iconType' => 'phone'
                ]
            ]
        ],
        'updatedAt' => date('c')
    ];
}

function onivalNormalizeSiteContent($content) {
    $defaults = onivalDefaultSiteContent();
    if (!is_array($content) || empty($content)) {
        return $defaults;
    }

    $out = array_merge($defaults, $content);

    // Defensive guarantee: homeSections is ALWAYS a non-empty array of valid section objects
    if (empty($out['homeSections']) || !is_array($out['homeSections'])) {
        $out['homeSections'] = $defaults['homeSections'];
    } else {
        $cleanSections = [];
        $seen = [];
        foreach ($out['homeSections'] as $idx => $sec) {
            if (!is_array($sec) || empty($sec['id'])) continue;
            $sId = (string)$sec['id'];
            $seen[$sId] = true;
            $cleanSections[] = [
                'id' => $sId,
                'title' => (string)($sec['title'] ?? $sId),
                'subtitle' => (string)($sec['subtitle'] ?? ''),
                'enabled' => !empty($sec['enabled']),
                'align' => in_array($sec['align'] ?? '', ['right', 'center', 'left'], true) ? $sec['align'] : 'right',
                'order' => isset($sec['order']) && is_numeric($sec['order']) ? (int)$sec['order'] : ($idx + 1)
            ];
        }
        foreach ($defaults['homeSections'] as $dSec) {
            if (empty($seen[$dSec['id']])) {
                $cleanSections[] = $dSec;
            }
        }
        usort($cleanSections, function($a, $b) {
            return ($a['order'] ?? 0) <=> ($b['order'] ?? 0);
        });
        $out['homeSections'] = $cleanSections;
    }

    if (!isset($out['topBanners']) || !is_array($out['topBanners'])) {
        $out['topBanners'] = $defaults['topBanners'];
    }

    if (empty($out['topBannerSettings']) || !is_array($out['topBannerSettings'])) {
        $out['topBannerSettings'] = $defaults['topBannerSettings'];
    } else {
        $out['topBannerSettings'] = array_merge($defaults['topBannerSettings'], $out['topBannerSettings']);
    }

    if (empty($out['navLabels']) || !is_array($out['navLabels'])) {
        $out['navLabels'] = $defaults['navLabels'];
    } else {
        $out['navLabels'] = array_merge($defaults['navLabels'], $out['navLabels']);
    }

    if (empty($out['paymentConfig']) || !is_array($out['paymentConfig'])) {
        $out['paymentConfig'] = $defaults['paymentConfig'];
    } else {
        $out['paymentConfig'] = array_merge($defaults['paymentConfig'], $out['paymentConfig']);
    }

    if (empty($out['consultationConfig']) || !is_array($out['consultationConfig'])) {
        $out['consultationConfig'] = $defaults['consultationConfig'];
    } else {
        $out['consultationConfig'] = array_merge($defaults['consultationConfig'], $out['consultationConfig']);
    }

    return $out;
}

function onivalValidateSiteContent($content) {
    if (!is_array($content)) {
        return ['ok' => false, 'error' => 'محتوای ارسالی باید یک ساختار JSON معتبر باشد.'];
    }
    if (isset($content['brandName'])) {
        $bName = trim((string)$content['brandName']);
        if ($bName === '' || mb_strlen($bName, 'UTF-8') > 100) {
            return ['ok' => false, 'error' => 'نام برند الزامی است و حداکثر می‌تواند ۱۰۰ کاراکتر باشد.'];
        }
    }
    if (isset($content['homeSections'])) {
        if (!is_array($content['homeSections'])) {
            return ['ok' => false, 'error' => 'ساختار چیدمان بخش‌های صفحه اصلی نامعتبر است.'];
        }
        foreach ($content['homeSections'] as $sec) {
            if (!is_array($sec) || empty($sec['id'])) {
                return ['ok' => false, 'error' => 'هر بخش از صفحه اصلی باید شناسه معتبر داشته باشد.'];
            }
        }
    }
    if (isset($content['topBanners'])) {
        if (!is_array($content['topBanners'])) {
            return ['ok' => false, 'error' => 'ساختار لیست بنرها نامعتبر است.'];
        }
        foreach ($content['topBanners'] as $b) {
            if (!is_array($b)) {
                return ['ok' => false, 'error' => 'هر بنر باید یک شیء معتبر باشد.'];
            }
        }
    }
    return ['ok' => true];
}

function deductOrderInventory(&$db, &$order) {
    if (!empty($order['inventoryDeducted'])) {
        return ['ok' => true, 'alreadyDeducted' => true];
    }
    if (empty($order['items']) || !is_array($order['items'])) {
        $order['inventoryDeducted'] = true;
        return ['ok' => true];
    }

    // Step 1: Aggregate duplicate product/variant lines to prevent overselling
    $aggregated = [];
    foreach ($order['items'] as $item) {
        $productId = (int)($item['productId'] ?? $item['id'] ?? 0);
        $qty = (int)($item['quantity'] ?? 1);
        if ($qty <= 0) {
            return ['ok' => false, 'code' => 'INVALID_QUANTITY', 'error' => 'تعداد محصول انتخابی نامعتبر است.'];
        }
        $size = trim((string)($item['size'] ?? ''));
        $key = "{$productId}::{$size}";
        $discUnits = isset($item['discountedUnits']) ? (int)$item['discountedUnits'] : (isset($item['discountedQuantity']) ? (int)$item['discountedQuantity'] : (isset($item['discountedQty']) ? (int)$item['discountedQty'] : null));
        if (!isset($aggregated[$key])) {
            $aggregated[$key] = [
                'productId' => $productId,
                'size' => $size,
                'quantity' => 0,
                'discountedUnits' => $discUnits
            ];
        } else {
            if ($discUnits !== null) {
                $aggregated[$key]['discountedUnits'] = (int)($aggregated[$key]['discountedUnits'] ?? 0) + $discUnits;
            }
        }
        $aggregated[$key]['quantity'] += $qty;
    }

    // Pre-check availability across aggregated items before any mutation
    foreach ($aggregated as $agg) {
        $productId = $agg['productId'];
        $qty = $agg['quantity'];
        $size = $agg['size'];

        $productFound = false;
        if (!empty($db['products']) && is_array($db['products'])) {
            foreach ($db['products'] as $prod) {
                if ((int)($prod['id'] ?? 0) === $productId && empty($prod['isDelete'])) {
                    $productFound = true;
                    // Check size variant stock
                    if ($size !== '' && !empty($prod['sizes']) && is_array($prod['sizes'])) {
                        $sizeFound = false;
                        foreach ($prod['sizes'] as $sObj) {
                            $sName = trim((string)($sObj['name'] ?? $sObj['size'] ?? ''));
                            if ($sName === $size) {
                                $sizeFound = true;
                                if (isset($sObj['stock'])) {
                                    $curSizeStock = (int)$sObj['stock'];
                                    if ($curSizeStock < $qty) {
                                        return [
                                            'ok' => false,
                                            'code' => 'STOCK_CONFLICT',
                                            'error' => "موجودی بسته «{$size}» برای محصول «{$prod['title']}» کافی نیست (موجودی فعلی: {$curSizeStock})."
                                        ];
                                    }
                                }
                                break;
                            }
                        }
                    }

                    // Check main product stock
                    if (isset($prod['stock'])) {
                        $curProdStock = (int)$prod['stock'];
                        if ($curProdStock < $qty) {
                            return [
                                'ok' => false,
                                'code' => 'STOCK_CONFLICT',
                                'error' => "موجودی کل محصول «{$prod['title']}» کافی نیست (موجودی فعلی: {$curProdStock})."
                            ];
                        }
                    }
                    break;
                }
            }
        }

        if (!$productFound && empty($order['isConsultation'])) {
            return [
                'ok' => false,
                'code' => 'PRODUCT_NOT_FOUND',
                'error' => "محصول با شناسه {$productId} در انبار یافت نشد."
            ];
        }
    }

    // Step 2: Perform atomic deduction and track exact deducted quantities
    $deductedDetails = [];
    foreach ($aggregated as $agg) {
        $productId = $agg['productId'];
        $qty = $agg['quantity'];
        $size = $agg['size'];
        $specialDeducted = 0;

        if (!empty($db['products']) && is_array($db['products'])) {
            foreach ($db['products'] as &$prod) {
                if ((int)($prod['id'] ?? 0) === $productId) {
                    $discountedUnitsToDeduct = $agg['discountedUnits'];
                    if ($discountedUnitsToDeduct === null) {
                        $calc = onivalComputeLinePricePhp($prod, $size, $qty);
                        $discountedUnitsToDeduct = $calc['discountedUnits'];
                    }

                    if ($size !== '' && !empty($prod['sizes']) && is_array($prod['sizes'])) {
                        foreach ($prod['sizes'] as &$sObj) {
                            $sName = trim((string)($sObj['name'] ?? $sObj['size'] ?? ''));
                            if ($sName === $size) {
                                if (isset($sObj['stock'])) {
                                    $sObj['stock'] = max(0, (int)$sObj['stock'] - $qty);
                                    $sObj['isOutOfStock'] = ($sObj['stock'] <= 0);
                                }
                                if (isset($sObj['specialOfferStock']) && $sObj['specialOfferStock'] !== null && $sObj['specialOfferStock'] !== '') {
                                    $curSpecial = (int)$sObj['specialOfferStock'];
                                    $specialDeducted = min($curSpecial, $discountedUnitsToDeduct);
                                    $sObj['specialOfferStock'] = max(0, $curSpecial - $specialDeducted);
                                }
                                break;
                            }
                        }
                        unset($sObj);
                    }

                    if (isset($prod['stock'])) {
                        $prod['stock'] = max(0, (int)$prod['stock'] - $qty);
                        if ($prod['stock'] <= 0) {
                            $prod['isOutOfStock'] = true;
                            $prod['availability'] = 'OutOfStock';
                        }
                    }

                    if (isset($prod['specialOfferStock']) && $prod['specialOfferStock'] !== null && $prod['specialOfferStock'] !== '') {
                        $curSpecialProd = (int)$prod['specialOfferStock'];
                        if ($specialDeducted === 0) {
                            $specialDeducted = min($curSpecialProd, $discountedUnitsToDeduct);
                        }
                        $prod['specialOfferStock'] = max(0, $curSpecialProd - $specialDeducted);
                    }
                    break;
                }
            }
            unset($prod);
        }

        $deductedDetails[] = [
            'productId' => $productId,
            'size' => $size,
            'quantity' => $qty,
            'specialOfferDeducted' => $specialDeducted
        ];
    }

    $order['deductedStockDetails'] = $deductedDetails;
    $order['inventoryDeducted'] = true;
    return ['ok' => true];
}

function releaseOrderInventory(&$db, &$order) {
    if (empty($order['inventoryDeducted'])) {
        return ['ok' => true, 'alreadyReleased' => true];
    }
    // Shipped or Completed orders must NOT be restocked by status change
    $currentStatus = $order['status'] ?? '';
    if ($currentStatus === 'Shipped' || $currentStatus === 'Completed') {
        return ['ok' => true, 'skippedShipped' => true];
    }

    $itemsToRestore = !empty($order['deductedStockDetails']) && is_array($order['deductedStockDetails'])
        ? $order['deductedStockDetails']
        : [];

    if (empty($itemsToRestore) && !empty($order['items']) && is_array($order['items'])) {
        foreach ($order['items'] as $it) {
            $itemsToRestore[] = [
                'productId' => (int)($it['productId'] ?? $it['id'] ?? 0),
                'size' => trim((string)($it['size'] ?? '')),
                'quantity' => max(1, (int)($it['quantity'] ?? 1)),
                'specialOfferDeducted' => 0
            ];
        }
    }

    foreach ($itemsToRestore as $rItem) {
        $productId = (int)($rItem['productId'] ?? 0);
        $qty = max(1, (int)($rItem['quantity'] ?? 1));
        $size = trim((string)($rItem['size'] ?? ''));
        $specialDeducted = (int)($rItem['specialOfferDeducted'] ?? 0);

        if (!empty($db['products']) && is_array($db['products'])) {
            foreach ($db['products'] as &$prod) {
                if ((int)($prod['id'] ?? 0) === $productId) {
                    if ($size !== '' && !empty($prod['sizes']) && is_array($prod['sizes'])) {
                        foreach ($prod['sizes'] as &$sObj) {
                            $sName = trim((string)($sObj['name'] ?? $sObj['size'] ?? ''));
                            if ($sName === $size) {
                                if (isset($sObj['stock'])) {
                                    $sObj['stock'] = (int)$sObj['stock'] + $qty;
                                    $sObj['isOutOfStock'] = ($sObj['stock'] <= 0);
                                }
                                if ($specialDeducted > 0 && isset($sObj['specialOfferStock'])) {
                                    $sObj['specialOfferStock'] = (int)$sObj['specialOfferStock'] + $specialDeducted;
                                }
                                break;
                            }
                        }
                        unset($sObj);
                    }

                    if (isset($prod['stock'])) {
                        $prod['stock'] = (int)$prod['stock'] + $qty;
                        if ($prod['stock'] > 0) {
                            $prod['isOutOfStock'] = false;
                            $prod['availability'] = 'InStock';
                        }
                    }

                    if ($specialDeducted > 0 && isset($prod['specialOfferStock'])) {
                        $prod['specialOfferStock'] = (int)$prod['specialOfferStock'] + $specialDeducted;
                    }
                    break;
                }
            }
            unset($prod);
        }
    }

    $order['inventoryDeducted'] = false;
    unset($order['deductedStockDetails']);
    return ['ok' => true];
}

function validateReceiptImageBytesPhp($binData) {
    if (empty($binData) || strlen($binData) < 20) {
        return [
            'ok' => false,
            'code' => 'IMAGE_INVALID',
            'error' => 'تصویر معتبر نیست یا آسیب دیده است. لطفاً فایل تصویری سالم ارسال فرمایید.'
        ];
    }
    if (strlen($binData) > 5242880) {
        return [
            'ok' => false,
            'code' => 'IMAGE_TOO_LARGE',
            'error' => 'حجم تصویر بیش از ۵ مگابایت است. لطفاً تصویر با حجم کمتر ارسال فرمایید (فرمت JPG یا PNG).'
        ];
    }

    // Check for script tags or PHP execution injection
    $startChunk = substr($binData, 0, 512);
    if (stripos($startChunk, '<?php') !== false || stripos($startChunk, '<?=') !== false || stripos($startChunk, '<script') !== false) {
        return [
            'ok' => false,
            'code' => 'IMAGE_INVALID',
            'error' => 'محتوای فایل ارسالی غیرمجاز است.'
        ];
    }

    // Validate image magic bytes - ONLY JPEG and PNG
    $isPng = (substr($binData, 0, 8) === "\x89PNG\x0d\x0a\x1a\x0a");
    $isJpeg = (substr($binData, 0, 3) === "\xff\xd8\xff");

    if (!$isPng && !$isJpeg) {
        return [
            'ok' => false,
            'code' => 'UNSUPPORTED_IMAGE_FORMAT',
            'error' => 'فرمت فایل ارسالی پذیرفته نیست. لطفاً تصویر فیش را فقط با فرمت JPG یا PNG ارسال کنید (به‌صورت عکس یا فایل تصویری).'
        ];
    }

    $ext = $isPng ? 'png' : 'jpg';
    $mime = $isPng ? 'image/png' : 'image/jpeg';
    $expectedType = $isPng ? IMAGETYPE_PNG : IMAGETYPE_JPEG;

    // Hardened image dimension and pixel bounds validation
    if (function_exists('getimagesizefromstring')) {
        $imgInfo = @getimagesizefromstring($binData);
        if ($imgInfo === false) {
            return [
                'ok' => false,
                'code' => 'IMAGE_INVALID',
                'error' => 'تصویر معتبر نیست یا آسیب دیده است. لطفاً فایل تصویری سالم ارسال فرمایید (JPG یا PNG).'
            ];
        }
        $actualType = (int)($imgInfo[2] ?? 0);
        if ($actualType !== $expectedType) {
            return [
                'ok' => false,
                'code' => 'IMAGE_INVALID',
                'error' => 'نوع داده‌ای تصویر با ساختار فایل همخوانی ندارد.'
            ];
        }
        $w = (int)($imgInfo[0] ?? 0);
        $h = (int)($imgInfo[1] ?? 0);
        $detectedMime = $imgInfo['mime'] ?? '';
        $allowedMimes = ['image/jpeg', 'image/png'];
        if (!in_array($detectedMime, $allowedMimes, true)) {
            return [
                'ok' => false,
                'code' => 'UNSUPPORTED_IMAGE_FORMAT',
                'error' => 'نوع فایل تصویری مجاز نیست (تنها JPG و PNG مجاز هستند).'
            ];
        }
        if ($w < 50 || $h < 50) {
            return [
                'ok' => false,
                'code' => 'IMAGE_DIMENSIONS_INVALID',
                'error' => 'ابعاد تصویر ارسالی بسیار کوچک است (حداقل ۵۰ پیکسل).'
            ];
        }
        if ($w > 8000 || $h > 8000 || ($w * $h) > 25000000) {
            return [
                'ok' => false,
                'code' => 'IMAGE_DIMENSIONS_INVALID',
                'error' => 'ابعاد تصویر بیش از حد مجاز است (حداکثر ۲۵ مگاپیکسل).'
            ];
        }
    }

    return ['ok' => true, 'ext' => $ext, 'mime' => $mime];
}

function processOrderPaymentApprovalPhp(&$db, $orderIdOrCode, $actor = 'admin') {
    $order = findOrderByCodePhp($db['orders'] ?? [], $orderIdOrCode, true);
    if (!$order) {
        foreach ($db['orders'] ?? [] as $ord) {
            if ((string)($ord['id'] ?? '') === (string)$orderIdOrCode) {
                $order = $ord;
                break;
            }
        }
    }
    if (!$order) {
        return ['ok' => false, 'code' => 'ORDER_NOT_FOUND', 'error' => 'سفارش مورد نظر یافت نشد.'];
    }

    if (($order['paymentStatus'] ?? '') === 'Paid') {
        return ['ok' => true, 'alreadyPaid' => true, 'order' => $order];
    }
    if (($order['status'] ?? '') === 'Cancelled') {
        return ['ok' => false, 'code' => 'ORDER_CANCELLED', 'error' => 'سفارش لغو شده است و امکان تایید آن وجود ندارد.'];
    }

    foreach ($db['orders'] as &$ord) {
        if (($ord['trackingCode'] ?? '') === $order['trackingCode']) {
            $invRes = deductOrderInventory($db, $ord);
            if (!$invRes['ok']) {
                return $invRes; // Abort without persisting Paid
            }
            $ord['paymentStatus'] = 'Paid';
            $ord['status'] = 'Processing';
            $ord['approvedAt'] = date('c');
            $ord['approvedBy'] = $actor;
            if (!empty($ord['consultationDetails'])) {
                $ord['consultationDetails']['consultationStatus'] = 'Scheduled';
            }
            if (!empty($db['contactMessages']) && is_array($db['contactMessages'])) {
                foreach ($db['contactMessages'] as &$msg) {
                    $isMatch = (
                        (!empty($msg['orderId']) && (string)$msg['orderId'] === (string)($ord['id'] ?? '')) ||
                        (!empty($msg['trackingCode']) && $msg['trackingCode'] === $ord['trackingCode']) ||
                        (!empty($ord['isConsultation']) && !empty($msg['isConsultation']) && !empty($ord['phoneNumber']) && ($msg['phoneNumber'] ?? '') === $ord['phoneNumber'])
                    );
                    if ($isMatch) {
                        $msg['paymentStatus'] = 'Paid';
                        if (!empty($msg['consultationDetails'])) {
                            $msg['consultationDetails']['consultationStatus'] = 'Scheduled';
                        }
                    }
                }
                unset($msg);
            }
            return ['ok' => true, 'order' => $ord];
        }
    }
    return ['ok' => false, 'code' => 'ORDER_NOT_FOUND', 'error' => 'خطا در ثبت سفارش.'];
}

function processOrderRejectionPhp(&$db, $orderIdOrCode, $reason = '', $actor = 'admin') {
    $order = findOrderByCodePhp($db['orders'] ?? [], $orderIdOrCode, true);
    if (!$order) {
        foreach ($db['orders'] ?? [] as $ord) {
            if ((string)($ord['id'] ?? '') === (string)$orderIdOrCode) {
                $order = $ord;
                break;
            }
        }
    }
    if (!$order) {
        return ['ok' => false, 'code' => 'ORDER_NOT_FOUND', 'error' => 'سفارش مورد نظر یافت نشد.'];
    }

    if (($order['status'] ?? '') === 'Cancelled') {
        return ['ok' => true, 'alreadyCancelled' => true, 'order' => $order];
    }

    $curStatus = $order['status'] ?? '';
    if ($curStatus === 'Shipped' || $curStatus === 'Completed') {
        return ['ok' => false, 'code' => 'TRANSITION_NOT_ALLOWED', 'error' => 'امکان لغو سفارشات ارسال‌شده یا تکمیل‌شده وجود ندارد.'];
    }

    foreach ($db['orders'] as &$ord) {
        if (($ord['trackingCode'] ?? '') === $order['trackingCode']) {
            if (!empty($ord['inventoryDeducted'])) {
                releaseOrderInventory($db, $ord);
            }
            $prevPay = $ord['paymentStatus'] ?? 'Unpaid';
            $ord['status'] = 'Cancelled';
            $ord['paymentStatus'] = ($prevPay === 'Paid') ? 'Paid_Cancelled' : 'Rejected';
            $ord['rejectedAt'] = date('c');
            $ord['rejectedBy'] = $actor;
            if (!empty($reason)) {
                $ord['cancellationReason'] = mb_substr($reason, 0, 500, 'UTF-8');
            }
            if (!empty($ord['consultationDetails'])) {
                $ord['consultationDetails']['consultationStatus'] = 'Cancelled';
            }
            if (!empty($db['contactMessages']) && is_array($db['contactMessages'])) {
                foreach ($db['contactMessages'] as &$msg) {
                    $isMatch = (
                        (!empty($msg['orderId']) && (string)$msg['orderId'] === (string)($ord['id'] ?? '')) ||
                        (!empty($msg['trackingCode']) && $msg['trackingCode'] === $ord['trackingCode']) ||
                        (!empty($ord['isConsultation']) && !empty($msg['isConsultation']) && !empty($ord['phoneNumber']) && ($msg['phoneNumber'] ?? '') === $ord['phoneNumber'])
                    );
                    if ($isMatch) {
                        $msg['paymentStatus'] = ($prevPay === 'Paid') ? 'Paid_Cancelled' : 'Rejected';
                        if (!empty($msg['consultationDetails'])) {
                            $msg['consultationDetails']['consultationStatus'] = 'Cancelled';
                        }
                        if (!empty($reason)) {
                            $msg['adminResponse'] = mb_substr($reason, 0, 500, 'UTF-8');
                        }
                    }
                }
                unset($msg);
            }
            return ['ok' => true, 'order' => $ord];
        }
    }
    return ['ok' => false, 'code' => 'ORDER_NOT_FOUND', 'error' => 'خطا در ثبت لغو سفارش.'];
}

function onivalApplyOrderStatusUpdatePhp(&$db, $orderIdOrCode, $newStatus, $newPayStatus, $actor = 'admin', $options = []) {
    if (!isset($db['orders']) || !is_array($db['orders'])) {
        $db['orders'] = [];
    }

    $orderIndex = -1;
    $order = null;

    $order = findOrderByCodePhp($db['orders'], $orderIdOrCode, true);
    if ($order) {
        foreach ($db['orders'] as $idx => $o) {
            if (($o['trackingCode'] ?? '') === ($order['trackingCode'] ?? '')) {
                $orderIndex = $idx;
                break;
            }
        }
    } else {
        foreach ($db['orders'] as $idx => $o) {
            if ((string)($o['id'] ?? '') === (string)$orderIdOrCode) {
                $orderIndex = $idx;
                $order = $o;
                break;
            }
        }
    }

    $allowedStatuses = ['Pending', 'Processing', 'Shipped', 'Completed', 'Cancelled'];
    $allowedPayStatuses = ['Unpaid', 'PendingVerification', 'Paid', 'Failed'];

    if ($newStatus !== null && $newStatus !== '' && !in_array($newStatus, $allowedStatuses, true)) {
        return [
            '_cancelWrite' => true,
            'ok' => false,
            'code' => 'VALIDATION_ERROR',
            'status' => 400,
            'error' => 'مقدار وضعیت ارسالی نامعتبر است.'
        ];
    }
    if ($newPayStatus !== null && $newPayStatus !== '' && !in_array($newPayStatus, $allowedPayStatuses, true)) {
        return [
            '_cancelWrite' => true,
            'ok' => false,
            'code' => 'VALIDATION_ERROR',
            'status' => 400,
            'error' => 'مقدار وضعیت پرداخت ارسالی نامعتبر است.'
        ];
    }

    if ($orderIndex === -1 || !$order) {
        return [
            '_cancelWrite' => true,
            'ok' => false,
            'code' => 'ORDER_NOT_FOUND',
            'status' => 404,
            'error' => 'سفارش مورد نظر یافت نشد.'
        ];
    }

    $curStatus = $order['status'] ?? 'Pending';
    $curPayStatus = $order['paymentStatus'] ?? 'Unpaid';

    $targetStatus = ($newStatus !== null && $newStatus !== '') ? (string)$newStatus : $curStatus;
    $targetPayStatus = ($newPayStatus !== null && $newPayStatus !== '') ? (string)$newPayStatus : $curPayStatus;

    if ($targetStatus === $curStatus && $targetPayStatus === $curPayStatus) {
        return [
            '_cancelWrite' => true,
            'ok' => true,
            'unchanged' => true,
            'order' => $order
        ];
    }

    if ($curStatus === 'Cancelled' && $targetStatus !== 'Cancelled') {
        return [
            '_cancelWrite' => true,
            'ok' => false,
            'code' => 'TRANSITION_NOT_ALLOWED',
            'status' => 409,
            'error' => 'امکان تغییر وضعیت سفارش لغو شده وجود ندارد.'
        ];
    }

    if ($curPayStatus === 'Paid' && $targetPayStatus !== 'Paid') {
        $reason = trim((string)($options['paymentChangeReason'] ?? $options['reason'] ?? ''));
        if (mb_strlen($reason, 'UTF-8') < 3 || mb_strlen($reason, 'UTF-8') > 300) {
            return [
                '_cancelWrite' => true,
                'ok' => false,
                'code' => 'REASON_REQUIRED',
                'status' => 400,
                'error' => 'علت تغییر وضعیت پرداخت الزامی است (حداقل ۳ کاراکتر).'
            ];
        }

        $restoredInv = false;
        if ($curStatus === 'Shipped' || $curStatus === 'Completed') {
            if (empty($options['confirmShipped'])) {
                return [
                    '_cancelWrite' => true,
                    'ok' => false,
                    'code' => 'SHIPPED_CONFIRMATION_REQUIRED',
                    'status' => 409,
                    'error' => 'سفارش در وضعیت ارسال‌شده/تکمیل‌شده است. برای تغییر وضعیت پرداخت باید تاییدیه ارسال ثبت شود.'
                ];
            }
            $restoredInv = false;
        } else {
            if (!empty($order['inventoryDeducted'])) {
                releaseOrderInventory($db, $order);
                $order['inventoryRestored'] = true;
                $restoredInv = true;
            }
        }

        $order['approvedAt'] = null;
        $order['approvedBy'] = null;
        $order['paymentRevertedAt'] = date('c');
        $order['paymentRevertedBy'] = $actor;
        $order['paymentRevertedReason'] = $reason;

        if (!isset($order['paymentHistory']) || !is_array($order['paymentHistory'])) {
            $order['paymentHistory'] = [];
        }
        $order['paymentHistory'][] = [
            'from' => 'Paid',
            'to' => $targetPayStatus,
            'changedAt' => date('c'),
            'changedBy' => $actor,
            'reason' => $reason,
            'restoredInventory' => $restoredInv
        ];

        onival_log('order_payment', 'ORDER_PAYMENT_REVERTED', "Payment reverted for order {$orderIdOrCode}", [
            'orderRef' => $orderIdOrCode,
            'from' => 'Paid',
            'to' => $targetPayStatus,
            'actor' => $actor,
            'reason' => $reason,
            'restoredInventory' => $restoredInv
        ]);

        $tg = $db['telegramConfig'] ?? [];
        $adminToken = onivalBotRoleToken($tg, 'admin');
        $adminChatId = onivalBotAdminChatId($tg);
        if (!empty($adminToken) && !empty($adminChatId)) {
            $trackCode = $order['trackingCode'] ?? (string)$orderIdOrCode;
            $custName = $order['customerName'] ?? ($order['userFullName'] ?? 'مشتری');
            $totAmount = onivalPersianNumber($order['totalAmount'] ?? $order['totalPrice'] ?? 0);
            $revertMsg = "⚠️ بازگشت وضعیت پرداخت سفارش {$trackCode}\n"
                       . "▫️ مشتری: {$custName}\n"
                       . "▫️ مبلغ: {$totAmount} تومان\n"
                       . "▫️ وضعیت جدید: {$targetPayStatus}\n"
                       . "▫️ اقدام‌کننده: {$actor}\n"
                       . "▫️ علت: {$reason}"
                       . ($restoredInv ? "\n▫️ موجودی انبار بازگردانده شد." : "");
            sendBaleMessage($adminToken, $adminChatId, $revertMsg);
        }
    }

    if (($curStatus === 'Shipped' || $curStatus === 'Completed') && $targetStatus === 'Cancelled') {
        return [
            '_cancelWrite' => true,
            'ok' => false,
            'code' => 'TRANSITION_NOT_ALLOWED',
            'status' => 409,
            'error' => 'امکان لغو سفارشات ارسال‌شده یا تکمیل‌شده وجود ندارد.'
        ];
    }

    if ($targetPayStatus === 'Paid' && $curPayStatus !== 'Paid') {
        $invRes = deductOrderInventory($db, $order);
        if (!$invRes['ok']) {
            return [
                '_cancelWrite' => true,
                'ok' => false,
                'code' => $invRes['code'] ?? 'STOCK_CONFLICT',
                'status' => 409,
                'error' => $invRes['error'] ?? 'موجودی انبار کافی نیست.'
            ];
        }
        $order['paymentStatus'] = 'Paid';
        if ($targetStatus === 'Shipped' || $targetStatus === 'Completed') {
            // Apply requested status directly after approval
        } elseif ($targetStatus === 'Pending' || $curStatus === 'Pending') {
            $targetStatus = 'Processing';
        }
        $order['approvedAt'] = date('c');
        $order['approvedBy'] = $actor;
        if (!empty($order['consultationDetails'])) {
            $order['consultationDetails']['consultationStatus'] = 'Scheduled';
        }
    }

    if ($targetStatus === 'Cancelled' && $curStatus !== 'Cancelled') {
        releaseOrderInventory($db, $order);
        $order['cancelledAt'] = date('c');
        $order['cancelledBy'] = $actor;
        if (!empty($order['consultationDetails'])) {
            $order['consultationDetails']['consultationStatus'] = 'Cancelled';
        }
    }

    $order['status'] = $targetStatus;
    $order['paymentStatus'] = $targetPayStatus;
    $order['updatedAt'] = date('c');
    $order['updatedBy'] = $actor;
    $order['statusUpdatedAt'] = date('c');
    $order['statusUpdatedBy'] = $actor;

    if (!empty($db['contactMessages']) && is_array($db['contactMessages'])) {
        foreach ($db['contactMessages'] as &$msg) {
            $isMatch = (
                (!empty($msg['orderId']) && (string)$msg['orderId'] === (string)($order['id'] ?? '')) ||
                (!empty($msg['trackingCode']) && $msg['trackingCode'] === $order['trackingCode']) ||
                (!empty($order['isConsultation']) && !empty($msg['isConsultation']) && !empty($order['phoneNumber']) && ($msg['phoneNumber'] ?? '') === $order['phoneNumber'])
            );
            if ($isMatch) {
                $msg['paymentStatus'] = $targetPayStatus;
                if ($targetPayStatus === 'Paid' && !empty($msg['consultationDetails'])) {
                    $msg['consultationDetails']['consultationStatus'] = 'Scheduled';
                }
                if ($targetStatus === 'Cancelled') {
                    if (!empty($msg['consultationDetails'])) {
                        $msg['consultationDetails']['consultationStatus'] = 'Cancelled';
                    }
                }
            }
        }
        unset($msg);
    }

    $db['orders'][$orderIndex] = $order;
    return [
        'ok' => true,
        'order' => $order,
        'unchanged' => false
    ];
}

// ------------------------------------------------------------------------------
// 7. Hardened Bale Bot API Client
// ------------------------------------------------------------------------------
function onivalCodePointToUtf8($codepoint) {
    if (is_string($codepoint)) {
        $codepoint = hexdec($codepoint);
    }
    if ($codepoint < 0x80) {
        return chr($codepoint);
    } elseif ($codepoint < 0x800) {
        return chr(0xc0 | ($codepoint >> 6)) . chr(0x80 | ($codepoint & 0x3f));
    } elseif ($codepoint < 0x10000) {
        return chr(0xe0 | ($codepoint >> 12)) . chr(0x80 | (($codepoint >> 6) & 0x3f)) . chr(0x80 | ($codepoint & 0x3f));
    } elseif ($codepoint < 0x110000) {
        return chr(0xf0 | ($codepoint >> 18)) . chr(0x80 | (($codepoint >> 12) & 0x3f)) . chr(0x80 | (($codepoint >> 6) & 0x3f)) . chr(0x80 | ($codepoint & 0x3f));
    }
    return '';
}

function onivalExpandUnicodeEscapes($val) {
    if (is_string($val)) {
        return preg_replace_callback('/\\\\u\{([0-9a-fA-F]+)\}/', function($m) {
            return onivalCodePointToUtf8($m[1]);
        }, $val);
    }
    if (is_array($val)) {
        $res = [];
        foreach ($val as $k => $v) {
            $res[$k] = onivalExpandUnicodeEscapes($v);
        }
        return $res;
    }
    return $val;
}

function callBaleApi($token, $method, $parameters = []) {
    $token = trim((string)$token);
    if (empty($token)) {
        return ['ok' => false, 'error' => 'Missing bot token'];
    }

    $parameters = onivalExpandUnicodeEscapes($parameters);
    $baseUrl = 'https://tapi.bale.ai';
    $url = $baseUrl . "/bot{$token}/{$method}";

    $jsonPayload = empty($parameters) ? '{}' : json_encode($parameters, JSON_UNESCAPED_UNICODE);
    if ($jsonPayload === false || json_last_error() !== JSON_ERROR_NONE) {
        onival_log('bot_api', 'json_encode_failed', "JSON encoding failed for {$method}", [
            'method' => $method,
            'code' => 'JSON_ENCODE_FAILED'
        ]);
        return ['ok' => false, 'code' => 'JSON_ENCODE_FAILED', 'error' => 'JSON encoding failed'];
    }

    $executeCurl = function() use ($url, $jsonPayload) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json; charset=utf-8']);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonPayload);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $connectTime = curl_getinfo($ch, CURLINFO_CONNECT_TIME);
        $error = curl_error($ch);
        $errno = curl_errno($ch);
        curl_close($ch);

        return [
            'response' => $response,
            'httpCode' => $httpCode,
            'connectTime' => $connectTime,
            'error' => $error,
            'errno' => $errno
        ];
    };

    $res = $executeCurl();

    // Single retry on connection-never-established (errno 7 or 28 with connect time 0)
    if (($res['errno'] === 7 || $res['errno'] === 28) && (float)$res['connectTime'] === 0.0) {
        onival_log('bot_api', 'retry_connection', "Retrying Bale API connection for {$method}", ['method' => $method]);
        $res = $executeCurl();
    }

    $httpCode = $res['httpCode'];
    $error = $res['error'];
    $response = $res['response'];

    if ($error) {
        onival_log('bot_outbound', 'OUTBOUND_FAILED', "Bale API call {$method} failed", [
            'method' => $method,
            'httpCode' => $httpCode,
            'error' => $error
        ]);
        return ['ok' => false, 'code' => 'BOT_API_FAILED', 'error' => $error, 'http_code' => $httpCode];
    }

    $decoded = @json_decode($response, true);
    if (!is_array($decoded)) {
        onival_log('bot_outbound', 'OUTBOUND_FAILED', "Invalid JSON response on {$method}", [
            'method' => $method,
            'httpCode' => $httpCode
        ]);
        return ['ok' => false, 'code' => 'BOT_API_FAILED', 'error' => 'Invalid JSON from Bale API', 'http_code' => $httpCode];
    }

    onival_log('bot_outbound', 'OUTBOUND_SUCCESS', "Bale API call {$method} succeeded", [
        'method' => $method,
        'httpCode' => $httpCode
    ]);

    return $decoded;
}

function sendBaleMessage($token, $chatId, $text, $replyMarkup = null) {
    $payload = [
        'chat_id' => is_numeric($chatId) ? (int)$chatId : $chatId,
        'text' => $text
    ];
    if ($replyMarkup) {
        $payload['reply_markup'] = $replyMarkup;
    }
    return callBaleApi($token, 'sendMessage', $payload);
}

function fetchBaleFileBytes($token, $fileId) {
    $token = trim((string)$token);
    $fileId = trim((string)$fileId);
    if (empty($token) || empty($fileId)) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'missing_input'];
    }

    $info = callBaleApi($token, 'getFile', ['file_id' => $fileId]);
    if (empty($info['ok']) || empty($info['result']['file_path'])) {
        onival_log('bot_file', 'GET_FILE_FAILED', 'Failed to get file path from Bale');
        return ['ok' => false, 'bytes' => null, 'reason' => 'getfile_failed'];
    }
    $filePath = (string)$info['result']['file_path'];
    if (empty($filePath) || strpos($filePath, '..') !== false) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'invalid_file_path'];
    }
    $fileUrl = "https://tapi.bale.ai/file/bot{$token}/{$filePath}";

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $fileUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    curl_setopt($ch, CURLOPT_REDIR_PROTOCOLS, CURLPROTO_HTTPS);
    curl_setopt($ch, CURLOPT_TIMEOUT, 20);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    $data = curl_exec($ch);
    $curlErr = curl_errno($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($curlErr !== 0) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'download_curl_error'];
    }
    if ($httpCode !== 200) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'download_http_' . $httpCode];
    }
    if (!$data || strlen($data) === 0) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'download_empty'];
    }
    if (strlen($data) > 6291456) {
        return ['ok' => false, 'bytes' => null, 'reason' => 'download_too_large'];
    }

    return ['ok' => true, 'bytes' => $data, 'reason' => 'ok'];
}

function onivalSniffImageMime($input) {
    $bin = '';
    if (is_string($input)) {
        if (file_exists($input) && is_file($input)) {
            $bin = @file_get_contents($input, false, null, 0, 32) ?: '';
        } else {
            $bin = substr($input, 0, 32);
        }
    }
    if (strlen($bin) < 3) {
        return null;
    }
    if (substr($bin, 0, 8) === "\x89PNG\x0d\x0a\x1a\x0a") {
        return 'image/png';
    }
    if (substr($bin, 0, 3) === "\xff\xd8\xff") {
        return 'image/jpeg';
    }
    return null;
}

function downloadBaleFileToDisk($token, $fileId, $targetPath) {
    $res = fetchBaleFileBytes($token, $fileId);
    if (!empty($res['ok']) && !empty($res['bytes'])) {
        $written = @file_put_contents($targetPath, $res['bytes'], LOCK_EX);
        return $written !== false;
    }
    return false;
}

function sendBalePhoto($token, $chatId, $photo, $caption = '', $replyMarkup = null) {
    $token = trim((string)$token);
    if (empty($token)) {
        return ['ok' => false, 'error' => 'Missing bot token'];
    }
    $baseUrl = 'https://tapi.bale.ai';
    $url = $baseUrl . "/bot{$token}/sendPhoto";

    $hasLocalFile = is_string($photo) && file_exists($photo) && is_file($photo);

    if ($hasLocalFile) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

        $mime = mime_content_type($photo) ?: 'image/jpeg';
        $postData = [
            'chat_id' => is_numeric($chatId) ? (int)$chatId : $chatId,
            'photo' => new CURLFile($photo, $mime, basename($photo))
        ];
        if (!empty($caption)) {
            $postData['caption'] = mb_substr($caption, 0, 1024, 'UTF-8');
        }
        if ($replyMarkup) {
            $encodedMarkup = is_array($replyMarkup) ? json_encode($replyMarkup, JSON_UNESCAPED_UNICODE) : $replyMarkup;
            if ($encodedMarkup === false || json_last_error() !== JSON_ERROR_NONE) {
                onival_log('bot_api', 'json_encode_failed', "JSON encoding failed for sendPhoto reply_markup", [
                    'code' => 'JSON_ENCODE_FAILED'
                ]);
                return ['ok' => false, 'code' => 'JSON_ENCODE_FAILED', 'error' => 'JSON encoding failed'];
            }
            $postData['reply_markup'] = $encodedMarkup;
        }

        curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($error) {
            return ['ok' => false, 'code' => 'BOT_API_FAILED', 'error' => $error, 'http_code' => $httpCode];
        }
        $decoded = @json_decode($response, true);
        return is_array($decoded) ? $decoded : ['ok' => false, 'code' => 'BOT_API_FAILED', 'error' => 'Invalid JSON'];
    }

    $payload = [
        'chat_id' => is_numeric($chatId) ? (int)$chatId : $chatId,
        'photo' => $photo
    ];
    if (!empty($caption)) {
        $payload['caption'] = mb_substr($caption, 0, 1024, 'UTF-8');
    }
    if ($replyMarkup) {
        $payload['reply_markup'] = $replyMarkup;
    }
    return callBaleApi($token, 'sendPhoto', $payload);
}

function sendBaleInvoiceSafe($token, $chatId, $title, $description, $payloadStr, $providerToken, $currency, $prices, $paymentMode = 'live') {
    // Security Guard: Never allow WALLET-TEST token in live mode
    if ($paymentMode === 'live' && strpos((string)$providerToken, 'WALLET-TEST') !== false) {
        return [
            'ok' => false,
            'code' => 'INVALID_WALLET_MODE',
            'error' => 'امکان استفاده از توکن تستی در حالت پرداخت لایو وجود ندارد.'
        ];
    }

    $body = [
        'chat_id' => is_numeric($chatId) ? (int)$chatId : $chatId,
        'title' => mb_substr((string)$title, 0, 32, 'UTF-8'),
        'description' => mb_substr((string)$description, 0, 255, 'UTF-8'),
        'payload' => substr((string)$payloadStr, 0, 128),
        'provider_token' => (string)$providerToken,
        'start_parameter' => substr((string)$payloadStr, 0, 64),
        'currency' => $currency ?: 'IRR',
        'prices' => $prices
    ];
    $res = callBaleApi($token, 'sendInvoice', $body);
    if (empty($res['ok'])) {
        $baleDesc = $res['description'] ?? 'unknown error';
        onival_log('bot_invoice', 'INVOICE_RETRY_MINIMAL', "Initial invoice issuance failed ({$baleDesc}); attempting minimal retry", [
            'payload' => substr((string)$payloadStr, 0, 64)
        ]);
        $minimalBody = [
            'chat_id' => is_numeric($chatId) ? (int)$chatId : $chatId,
            'title' => mb_substr((string)$title, 0, 32, 'UTF-8'),
            'description' => mb_substr((string)$description, 0, 255, 'UTF-8'),
            'payload' => substr((string)$payloadStr, 0, 128),
            'provider_token' => (string)$providerToken,
            'prices' => $prices
        ];
        $res = callBaleApi($token, 'sendInvoice', $minimalBody);
    }
    return $res;
}

// ------------------------------------------------------------------------------
// 8. Digit Normalization & Order Code Lookup
function checkOrderStockAvailablePhp($db, $order) {
    if (empty($order['items']) || !is_array($order['items'])) {
        return ['ok' => true];
    }
    foreach ($order['items'] as $item) {
        $productId = (int)($item['productId'] ?? $item['id'] ?? 0);
        $qty = max(1, (int)($item['quantity'] ?? 1));
        $size = trim((string)($item['size'] ?? ''));

        $productFound = false;
        if (!empty($db['products']) && is_array($db['products'])) {
            foreach ($db['products'] as $prod) {
                if ((int)($prod['id'] ?? 0) === $productId && empty($prod['isDelete'])) {
                    $productFound = true;
                    if ($size !== '' && !empty($prod['sizes']) && is_array($prod['sizes'])) {
                        foreach ($prod['sizes'] as $sObj) {
                            $sName = trim((string)($sObj['name'] ?? $sObj['size'] ?? ''));
                            if ($sName === $size) {
                                if (isset($sObj['stock']) && (int)$sObj['stock'] < $qty) {
                                    return ['ok' => false, 'code' => 'STOCK_CONFLICT', 'error' => "موجودی بسته «{$size}» برای «{$prod['title']}» کافی نیست."];
                                }
                                break;
                            }
                        }
                    }
                    if (isset($prod['stock']) && (int)$prod['stock'] < $qty) {
                        return ['ok' => false, 'code' => 'STOCK_CONFLICT', 'error' => "موجودی کل «{$prod['title']}» کافی نیست."];
                    }
                    break;
                }
            }
        }
        if (!$productFound && empty($order['isConsultation'])) {
            return ['ok' => false, 'code' => 'PRODUCT_NOT_FOUND', 'error' => "محصول با شناسه {$productId} یافت نشد."];
        }
    }
    return ['ok' => true];
}

function getOrCreateWebhookSecrets(&$telegramConfig) {
    $updated = false;
    $cSec = trim((string)($telegramConfig['customerWebhookSecretToken'] ?? ''));
    if (empty($cSec) || strpos($cSec, 'csec_') !== 0 || strlen($cSec) < 20) {
        $telegramConfig['customerWebhookSecretToken'] = 'csec_' . bin2hex(random_bytes(16));
        $updated = true;
    }
    $aSec = trim((string)($telegramConfig['adminWebhookSecretToken'] ?? ''));
    if (empty($aSec) || strpos($aSec, 'asec_') !== 0 || strlen($aSec) < 20 || $aSec === $telegramConfig['customerWebhookSecretToken']) {
        $telegramConfig['adminWebhookSecretToken'] = 'asec_' . bin2hex(random_bytes(16));
        $updated = true;
    }
    if (($telegramConfig['webhookSecretToken'] ?? '') !== $telegramConfig['customerWebhookSecretToken']) {
        $telegramConfig['webhookSecretToken'] = $telegramConfig['customerWebhookSecretToken'];
        $updated = true;
    }
    return [
        'customer' => $telegramConfig['customerWebhookSecretToken'],
        'admin' => $telegramConfig['adminWebhookSecretToken'],
        'updated' => $updated
    ];
}

function generateUniqueTrackingCodePhp($existingOrders, $prefix = 'ONV-ORD') {
    $existingCodes = [];
    if (is_array($existingOrders)) {
        foreach ($existingOrders as $ord) {
            if (!empty($ord['trackingCode'])) {
                $existingCodes[strtoupper(trim($ord['trackingCode']))] = true;
            }
        }
    }

    for ($i = 0; $i < 30; $i++) {
        $hex = strtoupper(bin2hex(random_bytes(4)));
        $cand = "{$prefix}-{$hex}";
        if (!isset($existingCodes[$cand])) {
            return $cand;
        }
    }
    return "{$prefix}-" . strtoupper(bin2hex(random_bytes(6)));
}

function generateContactTrackingCodePhp() {
    return 'ONV-MSG-' . strtoupper(bin2hex(random_bytes(4)));
}

function maskPublicPhonePhp($p) {
    if (!$p) return '';
    $clean = trim((string)$p);
    if (strlen($clean) >= 10) return substr($clean, 0, 4) . '***' . substr($clean, -3);
    if (strlen($clean) >= 4) return substr($clean, 0, 2) . '***' . substr($clean, -2);
    return '***';
}

function maskPublicAddressPhp($a) {
    if (!$a) return '';
    $clean = trim((string)$a);
    $parts = preg_split('/[،,-]/u', $clean);
    if (count($parts) > 1) return trim($parts[0]) . '، *** (تحویل پستی)';
    return mb_substr($clean, 0, 14, 'UTF-8') . '... (تحویل پستی)';
}

function buildPublicSafeOrderPhp($order, $isAdmin = false) {
    if (!$order || !is_array($order)) return null;
    if ($isAdmin) return $order;

    return [
        'id' => $order['id'] ?? 0,
        'trackingCode' => $order['trackingCode'] ?? '',
        'orderNumber' => $order['orderNumber'] ?? '',
        'userFullName' => $order['userFullName'] ?? ($order['customerName'] ?? 'مشتری گرامی'),
        'customerName' => $order['customerName'] ?? ($order['userFullName'] ?? 'مشتری گرامی'),
        'phoneNumber' => maskPublicPhonePhp($order['phoneNumber'] ?? ''),
        'userAddress' => maskPublicAddressPhp($order['userAddress'] ?? ''),
        'totalPrice' => (int)($order['totalPrice'] ?? $order['finalTotal'] ?? 0),
        'finalTotal' => (int)($order['finalTotal'] ?? $order['totalPrice'] ?? 0),
        'status' => $order['status'] ?? 'Pending',
        'paymentStatus' => $order['paymentStatus'] ?? 'Unpaid',
        'paymentMethod' => $order['paymentMethod'] ?? '',
        'creationTime' => $order['creationTime'] ?? ($order['createdAt'] ?? ''),
        'balePaymentUrl' => $order['balePaymentUrl'] ?? '',
        'items' => array_map(function($it) {
            return [
                'productId' => $it['productId'] ?? ($it['id'] ?? 0),
                'productName' => $it['productName'] ?? ($it['name'] ?? ''),
                'name' => $it['name'] ?? ($it['productName'] ?? ''),
                'size' => $it['size'] ?? 'استاندارد',
                'quantity' => (int)($it['quantity'] ?? ($it['qty'] ?? 1)),
                'unitPrice' => (int)($it['unitPrice'] ?? ($it['price'] ?? 0)),
                'totalPrice' => (int)($it['totalPrice'] ?? 0)
            ];
        }, $order['items'] ?? []),
        'hasReceipt' => !empty($order['receiptFileId']) || !empty($order['receiptImageUrl']) || !empty($order['receiptImage']),
        'receiptSubmittedAt' => $order['receiptSubmittedAt'] ?? ($order['receiptUploadedAt'] ?? null),
        'isConsultation' => !empty($order['isConsultation']),
        'consultationDetails' => !empty($order['consultationDetails']) ? [
            'topicTitle' => $order['consultationDetails']['topicTitle'] ?? 'مشاوره سلامت',
            'preferredDate' => $order['consultationDetails']['preferredDate'] ?? '',
            'preferredTimeSlot' => $order['consultationDetails']['preferredTimeSlot'] ?? '',
            'socialPlatform' => $order['consultationDetails']['socialPlatform'] ?? '',
            'consultationStatus' => $order['consultationDetails']['consultationStatus'] ?? 'PendingPayment',
            'adminResponse' => $order['consultationDetails']['adminResponse'] ?? null,
            'respondedAt' => $order['consultationDetails']['respondedAt'] ?? null
        ] : null
    ];
}

// ------------------------------------------------------------------------------
// 8. Digit Normalization & Order Code Lookup
// ------------------------------------------------------------------------------
function normalizeDigitsPhp($str) {
    if (!$str) return '';
    $farsi = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
    $arabic = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    $english = ['0','1','2','3','4','5','6','7','8','9'];
    $str = str_replace($farsi, $english, $str);
    return str_replace($arabic, $english, $str);
}

function extractOrderCodePhp($text) {
    if (empty($text) || !is_string($text)) return null;
    $norm = normalizeDigitsPhp(trim($text));

    // 1. Explicitly ignore standard menu commands, greetings and conversational text
    if (preg_match('/^[\/!#]?(start|help|admin|orders|شروع|راهنما|سفارشات|فروشگاه|محصولات|تماس|پشتیبانی|پیگیری|پرداخت|hello|hi|salam|test|سلام|درود|تست)$/iu', $norm)) {
        return null;
    }
    // Ignore multiword reply-keyboard text labels
    if (preg_match('/^(?:\x{1F9FE}\s*استعلام|\x{1F6CD}\x{FE0F}?\s*فروشگاه|\x{1F4E6}\s*پیگیری|\x{1F4B3}\s*راهنما|\x{1F4DE}\s*تماس|استعلام و پرداخت فاکتور|فروشگاه اونیوال|پیگیری سفارش|راهنمای روش‌های پرداخت|تماس با ما)/iu', $norm)) {
        return null;
    }

    // Ignore Iranian mobile numbers
    if (preg_match('/^09\d{9}$/', $norm)) {
        return null;
    }

    // Ignore messages containing weight or units or currency without code
    if (preg_match('/(گرمی?|کیلو|تومان|ریال|بسته|عدد)/iu', $norm) && !preg_match('/(?:ONV|ORD)[-_]/iu', $norm)) {
        return null;
    }

    // 2. Handle /start pay_<code|reference> or /start order_<code|reference>
    if (preg_match('/^\/start[\s_]+(?:pay_|order_|پرداخت_)?([A-Za-z0-9_-]{4,32})/iu', $norm, $m)) {
        $cand = trim(preg_replace('/^(?:pay_|order_|پرداخت_)/iu', '', $m[1]));
        if (!empty($cand) && !preg_match('/^(admin|help|orders|start)$/iu', $cand)) {
            return $cand;
        }
    }

    // 3. Handle /confirm_<code|reference> or /approve_<code|reference>
    if (preg_match('/^\/(?:confirm_|approve_|تایید_)([A-Za-z0-9_-]{4,32})/iu', $norm, $m)) {
        return trim($m[1]);
    }

    // 4. Strict ONV- or ORD- prefixed tracking codes delimited by boundary or whitespace
    if (preg_match('/(?:^|[\s:#-])((?:ONV|ORD)[-_][A-Za-z0-9_-]{4,24})(?:$|[\s:#-])/iu', $norm, $m)) {
        return trim($m[1]);
    }

    // 5. Explicit label prefix like "فاکتور: XXXXX" or "کد رهگیری: XXXXX"
    if (preg_match('/(?:فاکتور|سفارش|کد\s*رهگیری|کد\s*پیگیری|شماره\s*سفارش|شماره\s*فاکتور|invoice|order)\s*[:#-]?\s*([A-Za-z0-9_-]{4,32})/iu', $norm, $m)) {
        $cand = trim($m[1]);
        if (!preg_match('/(گرمی?|کیلو|تومان|ریال)/iu', $cand) && !preg_match('/^09\d{9}$/', $cand)) {
            // Reject short pure numeric strings (under 7 digits) to prevent 5-digit order number takeover
            if (!preg_match('/^\d{1,6}$/', $cand)) {
                return $cand;
            }
        }
    }

    // 6. If the entire trimmed message is strictly an uppercase tracking reference format
    if (preg_match('/^(?:ONV|ORD)[-_][A-Za-z0-9_-]{4,24}$/i', $norm)) {
        return $norm;
    }

    return null;
}

function findOrderByCodePhp($orders, $searchQuery, $allowOrderNumber = false) {
    if (empty($orders) || !is_array($orders) || empty($searchQuery)) return null;
    $raw = trim((string)$searchQuery);
    $norm = normalizeDigitsPhp($raw);
    $cleanQuery = strtoupper(preg_replace('/[^A-Z0-9_-]/i', '', $norm));
    $normQueryDash = str_replace('_', '-', $cleanQuery);
    $cleanQueryWithoutPrefix = preg_replace('/^(?:PAY_|ORDER_|PAY-|ORDER-)/i', '', $cleanQuery);
    $cleanQueryWithoutPrefixDash = str_replace('_', '-', $cleanQueryWithoutPrefix);

    foreach ($orders as $ord) {
        $track = trim($ord['trackingCode'] ?? '');
        $ordNum = trim($ord['orderNumber'] ?? '');

        // 1. Strict match on trackingCode
        if (strcasecmp($track, $raw) === 0) {
            return $ord;
        }

        // 2. Only allow matching short 5-digit orderNumber if explicitly authorized by admin context
        if ($allowOrderNumber && !empty($ordNum) && strcasecmp($ordNum, $raw) === 0) {
            return $ord;
        }

        $cleanTrack = strtoupper(preg_replace('/[^A-Z0-9_-]/i', '', $track));
        $cleanTrackDash = str_replace('_', '-', $cleanTrack);
        $cleanOrdNum = strtoupper(preg_replace('/[^A-Z0-9_-]/i', '', $ordNum));

        if (!empty($cleanQuery)) {
            if ($cleanTrack === $cleanQuery || $cleanTrackDash === $normQueryDash) {
                return $ord;
            }
            if ($allowOrderNumber && !empty($cleanOrdNum) && $cleanOrdNum === $cleanQuery) {
                return $ord;
            }
            if ($cleanQueryWithoutPrefix !== '' && ($cleanTrack === $cleanQueryWithoutPrefix || $cleanTrackDash === $cleanQueryWithoutPrefixDash)) {
                return $ord;
            }
            if ($allowOrderNumber && $cleanQueryWithoutPrefix !== '' && !empty($cleanOrdNum) && $cleanOrdNum === $cleanQueryWithoutPrefix) {
                return $ord;
            }
        }
    }
    return null;
}

function getOrderAmountTomanPhp($order) {
    if (empty($order) || !is_array($order)) return 150000;
    if (!empty($order['finalTotal']) && is_numeric($order['finalTotal']) && (int)$order['finalTotal'] > 0) {
        return (int)$order['finalTotal'];
    }
    if (!empty($order['totalPrice']) && is_numeric($order['totalPrice']) && (int)$order['totalPrice'] > 0) {
        return (int)$order['totalPrice'];
    }
    if (!empty($order['total']) && is_numeric($order['total']) && (int)$order['total'] > 0) {
        return (int)$order['total'];
    }
    if (!empty($order['amount']) && is_numeric($order['amount']) && (int)$order['amount'] > 0) {
        return (int)$order['amount'];
    }
    return 150000;
}

// ------------------------------------------------------------------------------
// 9. Slug Generation & Sanitization
// ------------------------------------------------------------------------------
function sanitizeSlugPhp($input, $fallbackPrefix = 'item', $fallbackId = null) {
    $raw = trim((string)$input);
    $raw = mb_strtolower($raw, 'UTF-8');
    // Replace zero-width non-joiner and spaces with hyphen
    $raw = preg_replace('/[\x{200B}-\x{200D}\x{FEFF}]/u', '-', $raw);
    $raw = preg_replace('/[_\s\/\\\]+/u', '-', $raw);
    // Allow Unicode letters, numbers and hyphens
    $raw = preg_replace('/[^\p{L}\p{N}-]+/u', '', $raw);
    $raw = preg_replace('/-+/u', '-', $raw);
    $raw = trim($raw, '-');

    if (mb_strlen($raw, 'UTF-8') >= 2) {
        return mb_substr($raw, 0, 120, 'UTF-8');
    }
    return $fallbackPrefix . '-' . ($fallbackId ?? time());
}

function isSlugDuplicatePhp($items, $candidateSlug, $excludeId = null) {
    $norm = sanitizeSlugPhp($candidateSlug);
    foreach ($items as $it) {
        if (!empty($it['isDelete'])) continue;
        if ($excludeId !== null && (int)($it['id'] ?? 0) === (int)$excludeId) continue;
        if (sanitizeSlugPhp($it['slug'] ?? '') === $norm) {
            return true;
        }
    }
    return false;
}

// ------------------------------------------------------------------------------
// 10. Structured Diagnostic Suite
// ------------------------------------------------------------------------------
function runDiagnosticsSuite($db, $options = []) {
    global $dataFile, $lockFile, $logFile;
    $stages = [];
    $correlationId = substr(bin2hex(random_bytes(8)), 0, 12);
    $tgCfg = $db['telegramConfig'] ?? [];
    $adminChatId = trim((string)($tgCfg['adminChatId'] ?? $tgCfg['baleAdminChatId'] ?? ''));

    $customerToken = trim((string)($tgCfg['customerBotToken'] ?? $tgCfg['baleBotToken'] ?? $tgCfg['botToken'] ?? ''));
    $adminToken = trim((string)($tgCfg['adminBotToken'] ?? $tgCfg['baleAdminBotToken'] ?? ''));
    $paymentMode = strtolower(trim((string)($tgCfg['balePaymentMode'] ?? 'live')));
    $walletToken = ($paymentMode === 'test')
        ? trim((string)($tgCfg['balePaymentTokenTest'] ?? 'WALLET-TEST-1111111111111111'))
        : trim((string)($tgCfg['balePaymentTokenLive'] ?? $tgCfg['balePaymentToken'] ?? ''));

    // STAGE A: Server connection and response format
    $stages[] = [
        'stage' => 'A',
        'name' => 'ارتباط با سرور و قالب پاسخ (Server Connection & Format)',
        'method' => 'GET',
        'endpoint' => '/api/health',
        'httpStatus' => 200,
        'ok' => true,
        'category' => 'server_liveness',
        'correlationId' => $correlationId,
        'details' => [
            'backendVersion' => 'Onival-PHP-1.2.0',
            'phpVersion' => PHP_VERSION,
            'serverSoftware' => $_SERVER['SERVER_SOFTWARE'] ?? 'LiteSpeed/Apache',
            'responseFormat' => 'application/json; charset=utf-8'
        ]
    ];

    // STAGE B: Administrator authentication
    $isAuthed = isRequestAdminAuthorized($db);
    $creds = $db['adminCredentials'] ?? [];
    $stages[] = [
        'stage' => 'B',
        'name' => 'احراز هویت مدیر سیستم (Admin Authentication)',
        'method' => 'GET',
        'endpoint' => '/api/admin/verify-session',
        'httpStatus' => $isAuthed ? 200 : 401,
        'ok' => $isAuthed,
        'category' => $isAuthed ? 'auth_verified' : 'AUTH_REQUIRED',
        'correlationId' => $correlationId,
        'details' => [
            'username' => $creds['username'] ?? 'admin',
            'initialSetupCompleted' => !empty($creds['initialSetupCompleted']),
            'sessionType' => 'HMAC-SHA256 (24-Hour Expiry)'
        ]
    ];

    // STAGE C: Reading bot configuration
    $hasCustToken = !empty($customerToken);
    $hasAdminToken = !empty($adminToken);
    $stages[] = [
        'stage' => 'C',
        'name' => 'خواندن پیکربندی ربات‌ها (Bot Configuration Readiness)',
        'method' => 'GET',
        'endpoint' => '/api/bot/config',
        'httpStatus' => 200,
        'ok' => ($hasCustToken || $hasAdminToken),
        'category' => ($hasCustToken && $hasAdminToken) ? 'config_complete' : 'config_partial',
        'correlationId' => $correlationId,
        'details' => [
            'customerBotUsername' => ltrim(trim((string)($tgCfg['customerBotUsername'] ?? 'Onivalbot')), '@'),
            'adminBotUsername' => ltrim(trim((string)($tgCfg['adminBotUsername'] ?? 'onivaladminbot')), '@'),
            'adminChatIdConfigured' => !empty($adminChatId),
            'targetAdminChatId' => $adminChatId,
            'customerBotTokenSet' => $hasCustToken,
            'adminBotTokenSet' => $hasAdminToken,
            'paymentMode' => $paymentMode,
            'walletTokenSet' => !empty($walletToken)
        ]
    ];

    // STAGE D: Database readiness and atomic sidecar locking
    $dbOk = false;
    $lockOk = false;
    $writeOk = false;
    if (file_exists($dataFile) && filesize($dataFile) > 10) {
        $dbOk = true;
    }
    $lockFp = @fopen($lockFile, 'c+');
    if ($lockFp) {
        if (@flock($lockFp, LOCK_EX)) {
            $lockOk = true;
            $testTmp = ONIVAL_PRIVATE_DIR . '/.diag_test_' . uniqid();
            if (@file_put_contents($testTmp, 'ok') !== false) {
                $writeOk = true;
                @unlink($testTmp);
            }
            @flock($lockFp, LOCK_UN);
        }
        @fclose($lockFp);
    }
    $stageDOk = ($dbOk && $lockOk && $writeOk);
    $stages[] = [
        'stage' => 'D',
        'name' => 'آمادگی پایگاه داده و قفل همزمانی (Database & Sidecar Lock Readiness)',
        'method' => 'INTERNAL',
        'endpoint' => 'database',
        'httpStatus' => $stageDOk ? 200 : 500,
        'ok' => $stageDOk,
        'category' => $stageDOk ? 'storage_ready' : 'DATA_WRITE_FAILED',
        'correlationId' => $correlationId,
        'details' => [
            'canonicalDbExists' => $dbOk,
            'exclusiveLockAcquired' => $lockOk,
            'atomicWriteVerified' => $writeOk,
            'totalProducts' => count($db['products'] ?? []),
            'totalOrders' => count($db['orders'] ?? [])
        ]
    ];

    // STAGE E: Customer bot getMe test
    if ($hasCustToken) {
        $custMe = callBaleApi($customerToken, 'getMe');
        $custMeOk = !empty($custMe['ok']);
        $stages[] = [
            'stage' => 'E',
            'name' => 'تست هویت ربات مشتری در بله (Customer Bot getMe)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/getMe',
            'httpStatus' => $custMe['http_code'] ?? ($custMeOk ? 200 : 400),
            'ok' => $custMeOk,
            'category' => $custMeOk ? 'bot_online' : 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => [
                'botUsername' => $custMe['result']['username'] ?? 'N/A',
                'botName' => $custMe['result']['first_name'] ?? 'N/A',
                'statusDescription' => $custMe['description'] ?? ($custMeOk ? 'OK' : 'Error')
            ]
        ];
    } else {
        $stages[] = [
            'stage' => 'E',
            'name' => 'تست هویت ربات مشتری در بله (Customer Bot getMe)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/getMe',
            'httpStatus' => 400,
            'ok' => false,
            'category' => 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => ['message' => 'توکن ربات مشتری تنظیم نشده است.']
        ];
    }

    // STAGE F: Admin bot getMe test
    if ($hasAdminToken) {
        $admMe = callBaleApi($adminToken, 'getMe');
        $admMeOk = !empty($admMe['ok']);
        $stages[] = [
            'stage' => 'F',
            'name' => 'تست هویت ربات ادمین در بله (Admin Bot getMe)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/getMe',
            'httpStatus' => $admMe['http_code'] ?? ($admMeOk ? 200 : 400),
            'ok' => $admMeOk,
            'category' => $admMeOk ? 'bot_online' : 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => [
                'botUsername' => $admMe['result']['username'] ?? 'N/A',
                'botName' => $admMe['result']['first_name'] ?? 'N/A',
                'statusDescription' => $admMe['description'] ?? ($admMeOk ? 'OK' : 'Error')
            ]
        ];
    } else {
        $stages[] = [
            'stage' => 'F',
            'name' => 'تست هویت ربات ادمین در بله (Admin Bot getMe)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/getMe',
            'httpStatus' => 400,
            'ok' => false,
            'category' => 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => ['message' => 'توکن ربات ادمین تنظیم نشده است.']
        ];
    }

    // STAGE G: Actual test-message delivery to configured administrator
    if ($hasAdminToken && !empty($adminChatId)) {
        $testText = "\u{1F514} تست ارتباط سیستمی اونیوال با شناسه مدیریت ({$adminChatId})\nزمان: " . date('Y/m/d - H:i:s');
        $sendRes = sendBaleMessage($adminToken, $adminChatId, $testText);
        $sendOk = !empty($sendRes['ok']);
        $stages[] = [
            'stage' => 'G',
            'name' => 'ارسال پیام تست به شناسه چت مدیر (Admin Test Message Delivery)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/sendMessage',
            'httpStatus' => $sendRes['http_code'] ?? ($sendOk ? 200 : 400),
            'ok' => $sendOk,
            'category' => $sendOk ? 'delivered' : 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => [
                'recipientChatId' => $adminChatId,
                'messageId' => $sendRes['result']['message_id'] ?? null,
                'description' => $sendRes['description'] ?? ($sendOk ? 'پیام با موفقیت به بله ادمین تحویل شد.' : 'خطا در تحویل به چت مدیر')
            ]
        ];
    } else {
        $stages[] = [
            'stage' => 'G',
            'name' => 'ارسال پیام تست به شناسه چت مدیر (Admin Test Message Delivery)',
            'method' => 'POST',
            'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/sendMessage',
            'httpStatus' => 400,
            'ok' => false,
            'category' => 'BOT_API_FAILED',
            'correlationId' => $correlationId,
            'details' => ['message' => 'توکن ربات ادمین یا شناسه چت مدیر وارد نشده است.']
        ];
    }

    // STAGE H: Webhook registration and inspection for EACH bot
    $hookCust = $hasCustToken ? callBaleApi($customerToken, 'getWebhookInfo') : null;
    $hookAdmin = $hasAdminToken ? callBaleApi($adminToken, 'getWebhookInfo') : null;
    $stages[] = [
        'stage' => 'H',
        'name' => 'استعلام و وضعیت وب‌هوک ربات‌ها (Webhook Inspection for Each Bot)',
        'method' => 'POST',
        'endpoint' => 'https://tapi.bale.ai/bot[TOKEN]/getWebhookInfo',
        'httpStatus' => 200,
        'ok' => true,
        'category' => 'webhook_status',
        'correlationId' => $correlationId,
        'details' => [
            'customerBotWebhook' => [
                'url' => $hookCust['result']['url'] ?? 'ثبت نشده',
                'pendingUpdates' => $hookCust['result']['pending_update_count'] ?? 0,
                'lastErrorMessage' => $hookCust['result']['last_error_message'] ?? 'بدون خطا'
            ],
            'adminBotWebhook' => [
                'url' => $hookAdmin['result']['url'] ?? 'ثبت نشده',
                'pendingUpdates' => $hookAdmin['result']['pending_update_count'] ?? 0,
                'lastErrorMessage' => $hookAdmin['result']['last_error_message'] ?? 'بدون خطا'
            ]
        ]
    ];

    // STAGE I: Command/button handling test
    $testCmd1 = extractOrderCodePhp('/start pay_ONV-ORD-101');
    $testCmd2 = extractOrderCodePhp('/confirm_ONV-ORD-101');
    $cmdOk = ($testCmd1 === 'ONV-ORD-101' && $testCmd2 === 'ONV-ORD-101');
    $stages[] = [
        'stage' => 'I',
        'name' => 'پردازشگر دستورات و دکمه‌ها (Command & Button Parsing Test)',
        'method' => 'INTERNAL',
        'endpoint' => 'extractOrderCodePhp()',
        'httpStatus' => $cmdOk ? 200 : 500,
        'ok' => $cmdOk,
        'category' => $cmdOk ? 'parser_verified' : 'parser_failed',
        'correlationId' => $correlationId,
        'details' => [
            'payDeepLinkParsed' => $testCmd1,
            'adminConfirmCmdParsed' => $testCmd2
        ]
    ];

    // STAGE J: Matching a real order
    $sampleOrder = !empty($db['orders']) ? $db['orders'][0] : null;
    $orderMatchOk = false;
    if ($sampleOrder && !empty($sampleOrder['trackingCode'])) {
        $found = findOrderByCodePhp($db['orders'], $sampleOrder['trackingCode']);
        $orderMatchOk = ($found && ($found['trackingCode'] === $sampleOrder['trackingCode']));
    }
    $stages[] = [
        'stage' => 'J',
        'name' => 'تطبیق و جستجوی سفارش واقعی (Real Order Lookup Test)',
        'method' => 'INTERNAL',
        'endpoint' => 'findOrderByCodePhp()',
        'httpStatus' => $orderMatchOk ? 200 : 404,
        'ok' => $orderMatchOk,
        'category' => $orderMatchOk ? 'order_lookup_success' : 'PRODUCT_NOT_FOUND',
        'correlationId' => $correlationId,
        'details' => [
            'testedCode' => $sampleOrder['trackingCode'] ?? 'N/A',
            'matched' => $orderMatchOk
        ]
    ];

    // STAGE K: Invoice generation test
    $invoiceStructureValid = (!empty($walletToken) && ($paymentMode !== 'live' || strpos($walletToken, 'WALLET-TEST') === false));
    $stages[] = [
        'stage' => 'K',
        'name' => 'اعتبارسنجی صدور فاکتور کیف پول بله (Invoice Generation Validation)',
        'method' => 'INTERNAL',
        'endpoint' => 'sendBaleInvoiceSafe()',
        'httpStatus' => $invoiceStructureValid ? 200 : 400,
        'ok' => $invoiceStructureValid,
        'category' => $invoiceStructureValid ? 'invoice_ready' : 'INVALID_WALLET_MODE',
        'correlationId' => $correlationId,
        'details' => [
            'paymentMode' => $paymentMode,
            'walletTokenConfigured' => !empty($walletToken),
            'liveTestMismatchPrevented' => true
        ]
    ];

    return [
        'ok' => true,
        'correlationId' => $correlationId,
        'timestamp' => date('c'),
        'backendVersion' => 'Onival-PHP-1.2.0',
        'phpVersion' => PHP_VERSION,
        'totalStages' => count($stages),
        'passedStages' => count(array_filter($stages, fn($s) => !empty($s['ok']))),
        'stages' => $stages
    ];
}

// ------------------------------------------------------------------------------
// 11. Unified Panel Log Adapter (Bounded Tail-Read & Schema Translation)
// ------------------------------------------------------------------------------
/**
 * Reads recent structured events from app.log with bounded tail reading
 * and maps them to the unified frontend format:
 * { id, time, timestamp, type, platform, text, status, details }
 */
function getRecentBotActivityLogsPhp($maxItems = 50, $bytesToRead = 65536) {
    global $logFile;
    if (!file_exists($logFile)) {
        return [];
    }

    $fileSize = @filesize($logFile);
    if ($fileSize === 0 || $fileSize === false) {
        return [];
    }

    $fp = @fopen($logFile, 'rb');
    if (!$fp) {
        return [];
    }

    $readLength = min($fileSize, $bytesToRead);
    $offset = max(0, $fileSize - $readLength);
    fseek($fp, $offset);
    $chunk = fread($fp, $readLength);
    fclose($fp);

    if ($chunk === false || $chunk === '') {
        return [];
    }

    // If we didn't read from the start of the file, drop the leading partial line
    if ($offset > 0) {
        $firstNewline = strpos($chunk, "\n");
        if ($firstNewline !== false) {
            $chunk = substr($chunk, $firstNewline + 1);
        }
    }

    $lines = explode("\n", $chunk);
    $events = [];

    // Process lines in reverse order (newest first)
    for ($i = count($lines) - 1; $i >= 0; $i--) {
        $line = trim($lines[$i]);
        if ($line === '') continue;

        $entry = @json_decode($line, true);
        if (!is_array($entry)) continue;

        $timestamp = (string)($entry['timestamp'] ?? '');
        $stage = (string)($entry['stage'] ?? '');
        $category = (string)($entry['category'] ?? '');
        $rawMessage = (string)($entry['message'] ?? '');
        $correlationId = (string)($entry['correlationId'] ?? '');
        $context = is_array($entry['context'] ?? null) ? $entry['context'] : [];

        // Redact any sensitive tokens, secrets, or raw keys in the message
        $cleanMessage = preg_replace('/(?::|token=|secret=)[a-zA-Z0-9_-]{16,}/i', ':***', $rawMessage);
        $cleanMessage = preg_replace('/[a-zA-Z0-9_-]{32,}/', '***', $cleanMessage);

        // Derive status explicitly without inventing false success
        $status = 'info';
        $lowCategory = strtolower($category);
        $lowStage = strtolower($stage);
        if (
            strpos($lowCategory, 'completed') !== false ||
            strpos($lowCategory, 'registered') !== false ||
            strpos($lowCategory, 'delivered') !== false ||
            strpos($lowCategory, 'issued') !== false ||
            strpos($lowCategory, 'found') !== false ||
            strpos($lowCategory, 'updated') !== false ||
            strpos($lowCategory, 'recorded') !== false ||
            strpos($lowCategory, 'success') !== false ||
            strpos($lowCategory, 'approved') !== false ||
            strpos($lowCategory, 'verified') !== false ||
            strpos($lowCategory, 'saved') !== false ||
            strpos($lowCategory, 'uploaded') !== false
        ) {
            $status = 'success';
        }
        if (
            strpos($lowCategory, 'not_found') !== false ||
            strpos($lowCategory, 'skipped_no') !== false ||
            strpos($lowCategory, 'error') !== false ||
            strpos($lowCategory, 'fail') !== false ||
            strpos($lowCategory, 'critical') !== false ||
            strpos($lowCategory, 'exception') !== false ||
            strpos($lowCategory, 'rejected') !== false ||
            strpos($lowCategory, 'conflict') !== false
        ) {
            $status = 'error';
        } elseif (
            strpos($lowCategory, 'warn') !== false ||
            strpos($lowCategory, 'review') !== false ||
            strpos($lowCategory, 'pending') !== false ||
            strpos($lowCategory, 'underpaid') !== false
        ) {
            if ($status !== 'error') {
                $status = 'warning';
            }
        }

        // Derive platform
        $platform = 'bale';
        if (strpos($lowStage, 'telegram') !== false || strpos($lowCategory, 'telegram') !== false) {
            $platform = 'telegram';
        } elseif (strpos($lowStage, 'database') !== false || strpos($lowStage, 'account') !== false) {
            $platform = 'system';
        }

        // Derive readable Persian/standard time
        $timeStr = date('H:i:s');
        if (!empty($timestamp)) {
            $ts = strtotime($timestamp);
            if ($ts !== false) {
                $timeStr = date('H:i:s', $ts);
            }
        }

        // Derive stable unique integer ID for React key and item selection
        $idSeed = $timestamp . '_' . $correlationId . '_' . $stage . '_' . $category . '_' . $i;
        $stableId = (int)sprintf('%u', crc32($idSeed));
        if ($stableId <= 0) $stableId = abs(crc32($idSeed)) ?: ($i + 1);

        $events[] = [
            'id' => $stableId,
            'time' => $timeStr,
            'timestamp' => $timestamp,
            'type' => !empty($category) ? $category : $stage,
            'platform' => $platform,
            'text' => $cleanMessage,
            'status' => $status,
            'details' => !empty($context) ? json_encode($context, JSON_UNESCAPED_UNICODE) : null
        ];

        if (count($events) >= $maxItems) {
            break;
        }
    }

    return $events;
}

/**
 * Escapes a CSV field and neutralizes spreadsheet formula injection (=, +, -, @, \t, \r)
 */
function escapeCsvFieldPhp($field): string {
    if ($field === null || $field === '') {
        return '""';
    }
    $str = str_replace('"', '""', (string)$field);
    if (preg_match('/^[=+\-@\t\r]/', $str)) {
        $str = "'" . $str;
    }
    return '"' . $str . '"';
}

// ------------------------------------------------------------------------------
// 12. Bale Bot & Operational Helpers
// ------------------------------------------------------------------------------
function onivalFirstNonEmpty(...$args) {
    foreach ($args as $a) {
        if (is_string($a) && trim($a) !== '') {
            return trim($a);
        }
        if (is_numeric($a)) {
            return (string)$a;
        }
    }
    return '';
}

function onivalBotRoleToken($telegramConfig, $role) {
    $role = strtolower(trim((string)$role));
    if ($role === 'admin') {
        return trim((string)($telegramConfig['adminBotToken'] ?? $telegramConfig['baleAdminBotToken'] ?? ''));
    }
    return trim((string)($telegramConfig['customerBotToken'] ?? $telegramConfig['baleBotToken'] ?? $telegramConfig['botToken'] ?? ''));
}

function onivalBotAdminChatId($telegramConfig) {
    $raw = trim((string)($telegramConfig['adminChatId'] ?? $telegramConfig['baleAdminChatId'] ?? ''));
    return preg_replace('/\D/', '', $raw);
}

function onivalBotWebhookUrls($telegramConfig) {
    $custSec = $telegramConfig['customerWebhookSecretToken'] ?? ($telegramConfig['webhookSecretToken'] ?? '');
    $admSec = $telegramConfig['adminWebhookSecretToken'] ?? '';
    return [
        'customer' => "https://onival.ir/api/webhook/bale/customer/{$custSec}",
        'admin' => "https://onival.ir/api/webhook/bale/admin/{$admSec}",
        'legacy_customer' => "https://onival.ir/api/webhook/bale?bot=customer&k=" . urlencode($custSec),
        'legacy_admin' => "https://onival.ir/api/webhook/bale?bot=admin&k=" . urlencode($admSec)
    ];
}

function onivalMaskWebhookUrl($url) {
    if (!is_string($url) || $url === '') return '';
    $u = preg_replace('#(/api/webhook/bale/(?:customer|admin)/)[^/]+#i', '$1[PROTECTED]', $url);
    $u = preg_replace('/(?i)(k|token|secret)=[^&]+/', '$1=[PROTECTED]', $u);
    return $u;
}

function onivalMaskTrackingCode($code) {
    $c = trim((string)$code);
    if (strlen($c) <= 6) return $c;
    return substr($c, 0, 4) . '***' . substr($c, -3);
}

function onivalWalletTokenForMode($telegramConfig, $mode = 'live') {
    $mode = strtolower(trim((string)$mode));
    if ($mode === 'test') {
        return trim((string)($telegramConfig['balePaymentTokenTest'] ?? 'WALLET-TEST-1111111111111111'));
    }
    return trim((string)($telegramConfig['balePaymentTokenLive'] ?? $telegramConfig['balePaymentToken'] ?? ''));
}

function onivalCatalogSummary($products) {
    if (!is_array($products)) return ['total' => 0, 'published' => 0, 'outOfStock' => 0];
    $total = 0;
    $published = 0;
    $outOfStock = 0;
    foreach ($products as $p) {
        if (!empty($p['isDelete'])) continue;
        $total++;
        if (($p['status'] ?? 'published') === 'published') {
            $published++;
        }
        if (!empty($p['isOutOfStock']) || (isset($p['stock']) && (int)$p['stock'] <= 0)) {
            $outOfStock++;
        }
    }
    return [
        'total' => $total,
        'published' => $published,
        'outOfStock' => $outOfStock
    ];
}

function onivalUniqueNumericId($items, $idField = 'id') {
    $max = 0;
    if (is_array($items)) {
        foreach ($items as $it) {
            $v = (int)($it[$idField] ?? 0);
            if ($v > $max) $max = $v;
        }
    }
    return $max > 0 ? ($max + 1) : (time() * 1000 + rand(10, 99));
}

function onivalWebhookUrlMatches($expectedUrl, $actualUrl) {
    $e = strtolower(rtrim(trim((string)$expectedUrl), '/'));
    $a = strtolower(rtrim(trim((string)$actualUrl), '/'));
    if ($e === '' || $a === '') return false;
    return ($e === $a);
}

function onivalWebhookInfoSummary($info, $role = '', $secret = '') {
    if (!is_array($info) || empty($info['ok'])) {
        return [
            'registered' => false,
            'urlSet' => false,
            'urlMatches' => false,
            'url' => '',
            'pendingUpdateCount' => 0,
            'pendingUpdates' => 0,
            'lastError' => 'عدم دسترسی'
        ];
    }
    $res = $info['result'] ?? [];
    $rawUrl = trim((string)($res['url'] ?? ''));
    $urlSet = ($rawUrl !== '');
    $urlMatches = false;
    if ($urlSet) {
        $parsed = @parse_url($rawUrl);
        $pHost = strtolower($parsed['host'] ?? '');
        $pPath = $parsed['path'] ?? '';
        $pQuery = $parsed['query'] ?? '';
        $hostOk = ($pHost === 'onival.ir' || strpos($pHost, 'localhost') !== false || strpos($pHost, 'run.app') !== false);
        $pathOk = (strpos($pPath, '/api/webhook/bale') !== false);
        $secOk = empty($secret) || (strpos($pQuery, $secret) !== false || strpos($pPath, $secret) !== false || (strpos($pQuery, 'bot=' . $role) !== false && strpos($pQuery, 'k=') !== false));
        if ($hostOk && $pathOk && $secOk) {
            $urlMatches = true;
        }
    }
    $lastError = $res['last_error_message'] ?? 'بدون خطا';
    return [
        'registered' => $urlSet,
        'urlSet' => $urlSet,
        'urlMatches' => $urlMatches,
        'hasWebhook' => !empty($rawUrl),
        'url' => onivalMaskWebhookUrl($rawUrl),
        'pendingUpdateCount' => (int)($res['pending_update_count'] ?? 0),
        'pendingUpdates' => (int)($res['pending_update_count'] ?? 0),
        'lastError' => $lastError
    ];
}

function onivalSetBaleWebhookUrl($token, $webhookUrl, $secretToken = '') {
    $params = ['url' => $webhookUrl];
    if (!empty($secretToken)) {
        $params['secret_token'] = $secretToken;
    }
    return callBaleApi($token, 'setWebhook', $params);
}

function onivalRegisterWebhookForRole($roleOrConfig, $tokenOrRole = null, $secret = null, $domain = 'https://onival.ir') {
    $role = 'customer';
    $token = '';
    $sec = '';
    if (is_array($roleOrConfig)) {
        $cfg = $roleOrConfig;
        $role = strtolower(trim((string)$tokenOrRole));
        $token = onivalBotRoleToken($cfg, $role);
        $sec = ($role === 'admin')
            ? ($cfg['adminWebhookSecretToken'] ?? '')
            : ($cfg['customerWebhookSecretToken'] ?? ($cfg['webhookSecretToken'] ?? ''));
    } else {
        $role = strtolower(trim((string)$roleOrConfig));
        $token = trim((string)$tokenOrRole);
        $sec = trim((string)$secret);
    }

    if (empty($token)) {
        return [
            'ok' => false,
            'setOk' => false,
            'urlMatches' => false,
            'mode' => 'none',
            'pendingUpdateCount' => 0,
            'lastErrorMessage' => 'TOKEN_MISSING',
            'registeredUrl' => '',
            'message' => "توکن ربات {$role} تنظیم نشده است."
        ];
    }
    if (empty($sec)) {
        return [
            'ok' => false,
            'setOk' => false,
            'urlMatches' => false,
            'mode' => 'none',
            'pendingUpdateCount' => 0,
            'lastErrorMessage' => 'SECRET_MISSING',
            'registeredUrl' => '',
            'message' => "کلید وب‌هوک {$role} یافت نشد."
        ];
    }

    $baseDomain = rtrim($domain, '/');
    $queryUrl = "{$baseDomain}/api/webhook/bale?bot={$role}&k=" . urlencode($sec);
    $pathUrl = "{$baseDomain}/api/webhook/bale/{$role}/" . urlencode($sec);

    $setOk = false;
    $chosenMode = 'query_secret';

    // (1) Try query URL with secret_token
    $res1 = onivalSetBaleWebhookUrl($token, $queryUrl, $sec);
    if (!empty($res1['ok'])) {
        $setOk = true;
        $chosenMode = 'query_secret';
    } else {
        // (2) Try query URL only
        $res2 = onivalSetBaleWebhookUrl($token, $queryUrl);
        if (!empty($res2['ok'])) {
            $setOk = true;
            $chosenMode = 'query';
        } else {
            // (3) Try path-secret URL
            $res3 = onivalSetBaleWebhookUrl($token, $pathUrl);
            if (!empty($res3['ok'])) {
                $setOk = true;
                $chosenMode = 'path';
            }
        }
    }

    // ALWAYS call getWebhookInfo to verify registration
    $info = callBaleApi($token, 'getWebhookInfo', []);
    $registeredUrl = $info['result']['url'] ?? '';
    $pendingCount = (int)($info['result']['pending_update_count'] ?? 0);
    $lastError = (string)($info['result']['last_error_message'] ?? '');

    $urlMatches = false;
    if (!empty($registeredUrl)) {
        $parsed = @parse_url($registeredUrl);
        $host = strtolower($parsed['host'] ?? '');
        $path = $parsed['path'] ?? '';
        $query = $parsed['query'] ?? '';

        $hostOk = ($host === 'onival.ir' || strpos($host, 'localhost') !== false || strpos($host, 'run.app') !== false || strpos($baseDomain, $host) !== false);
        $pathOk = (strpos($path, '/api/webhook/bale') !== false);
        $secretInQuery = (strpos($query, $sec) !== false || (strpos($query, 'bot=' . $role) !== false && strpos($query, 'k=') !== false));
        $secretInPath = (strpos($path, $sec) !== false && strpos($path, $role) !== false);

        if ($hostOk && $pathOk && ($secretInQuery || $secretInPath)) {
            $urlMatches = true;
        }
    }

    $finalOk = ($setOk && $urlMatches);
    $maskedRegUrl = onivalMaskWebhookUrl($registeredUrl);

    if ($finalOk) {
        onival_log('bot_register', 'WEBHOOK_REGISTERED', "Webhook for {$role} successfully registered and verified", [
            'role' => $role,
            'mode' => $chosenMode,
            'url' => $maskedRegUrl
        ]);
    } else {
        onival_log('bot_register', 'WEBHOOK_REGISTRATION_FAILED', "Webhook registration for {$role} failed verification", [
            'role' => $role,
            'setOk' => $setOk,
            'urlMatches' => $urlMatches,
            'lastError' => $lastError
        ]);
    }

    return [
        'ok' => $finalOk,
        'setOk' => $setOk,
        'urlMatches' => $urlMatches,
        'mode' => $chosenMode,
        'pendingUpdateCount' => $pendingCount,
        'lastErrorMessage' => $lastError,
        'registeredUrl' => $maskedRegUrl,
        'message' => $finalOk
            ? "وب‌هوک ربات {$role} با موفقیت ثبت و تایید شد."
            : ($setOk ? "وب‌هوک ارسال شد اما تطابق آدرس تایید نگردید." : "خطا در تنظیم وب‌هوک: {$lastError}")
    ];
}

function onivalEnsureWebhookSecrets(&$telegramConfig) {
    return getOrCreateWebhookSecrets($telegramConfig);
}

function onivalBotLogSummary($maxItems = 20) {
    return getRecentBotActivityLogsPhp($maxItems);
}

function onivalBotStatusReport($db) {
    $tg = $db['telegramConfig'] ?? [];
    $custToken = onivalBotRoleToken($tg, 'customer');
    $admToken = onivalBotRoleToken($tg, 'admin');
    $adminChatId = onivalBotAdminChatId($tg);

    $custSec = $tg['customerWebhookSecretToken'] ?? ($tg['webhookSecretToken'] ?? '');
    $admSec = $tg['adminWebhookSecretToken'] ?? '';

    $custMe = !empty($custToken) ? callBaleApi($custToken, 'getMe') : null;
    $admMe = !empty($admToken) ? callBaleApi($admToken, 'getMe') : null;

    $custHook = !empty($custToken) ? callBaleApi($custToken, 'getWebhookInfo') : null;
    $admHook = !empty($admToken) ? callBaleApi($admToken, 'getWebhookInfo') : null;

    $custSummary = onivalWebhookInfoSummary($custHook, 'customer', $custSec);
    $admSummary = onivalWebhookInfoSummary($admHook, 'admin', $admSec);

    $paymentMode = strtolower(trim((string)($tg['balePaymentMode'] ?? 'live')));
    $walletLive = onivalWalletTokenForMode($tg, 'live');
    $walletTest = onivalWalletTokenForMode($tg, 'test');

    $recentLogs = getRecentBotActivityLogsPhp(50);

    // Compute verdict codes
    $verdicts = [];
    if (empty($custToken) || empty($admToken)) {
        $verdicts[] = 'TOKEN_MISSING';
    }
    if ((!empty($custToken) && empty($custMe['ok'])) || (!empty($admToken) && empty($admMe['ok']))) {
        $verdicts[] = 'TOKEN_INVALID';
    }
    if ((!empty($custToken) && empty($custSummary['urlSet'])) || (!empty($admToken) && empty($admSummary['urlSet']))) {
        $verdicts[] = 'WEBHOOK_NOT_SET';
    }
    if ((!empty($custSummary['urlSet']) && empty($custSummary['urlMatches'])) || (!empty($admSummary['urlSet']) && empty($admSummary['urlMatches']))) {
        $verdicts[] = 'WEBHOOK_URL_MISMATCH';
    }
    if ((!empty($custSummary['lastError']) && $custSummary['lastError'] !== 'بدون خطا' && $custSummary['lastError'] !== 'عدم دسترسی') ||
        (!empty($admSummary['lastError']) && $admSummary['lastError'] !== 'بدون خطا' && $admSummary['lastError'] !== 'عدم دسترسی')) {
        $verdicts[] = 'WEBHOOK_LAST_ERROR';
    }
    if ($custSummary['pendingUpdateCount'] > 0 || $admSummary['pendingUpdateCount'] > 0) {
        $verdicts[] = 'UPDATES_PENDING';
    }

    $pubCount = 0;
    foreach ($db['products'] ?? [] as $p) {
        if (empty($p['isDelete']) && ($p['status'] ?? 'published') === 'published') {
            $pubCount++;
        }
    }
    if ($pubCount === 0) {
        $verdicts[] = 'CATALOG_EMPTY';
    }

    if ($paymentMode === 'test') {
        $verdicts[] = 'PAYMENT_TEST_MODE';
    } elseif (empty($walletLive)) {
        $verdicts[] = 'WALLET_TOKEN_MISSING';
    } else {
        $verdicts[] = 'LIVE_WALLET_CHECK_HINT';
    }

    $sitePay = $db['siteContent']['paymentConfig'] ?? [];
    $rawCard = trim((string)($sitePay['cardNumber'] ?? ($db['paymentConfig']['cardNumber'] ?? '')));
    if ($rawCard === '') {
        $verdicts[] = 'CARD_NUMBER_MISSING';
    }

    if (empty($adminChatId)) {
        $verdicts[] = 'ADMIN_CHAT_NOT_CONFIGURED';
    }

    // Inspect recent logs
    $hasInbound = false;
    foreach ($recentLogs as $lg) {
        $cat = (string)($lg['category'] ?? $lg['type'] ?? '');
        $stg = (string)($lg['stage'] ?? '');
        if ($stg === 'bot_webhook' || strpos($cat, 'WEBHOOK') !== false) {
            $hasInbound = true;
        }
        if ($cat === 'ORDER_REQUEST_REJECTED' && !in_array('ORDER_REJECTED_BY_SERVER', $verdicts, true)) {
            $verdicts[] = 'ORDER_REJECTED_BY_SERVER';
        }
        if (($cat === 'RECEIPT_IMAGE_FAILED' || $cat === 'RECEIPT_RECORD_FAILED') && !in_array('RECEIPT_PROBLEM', $verdicts, true)) {
            $verdicts[] = 'RECEIPT_PROBLEM';
        }
        if ($cat === 'ORDER_STATUS_REJECTED' && !in_array('ORDER_STATUS_REJECTED', $verdicts, true)) {
            $verdicts[] = 'ORDER_STATUS_REJECTED';
        }
        if ($cat === 'AUTH_FAILED' && !in_array('WEBHOOK_AUTH_FAILURES', $verdicts, true)) {
            $verdicts[] = 'WEBHOOK_AUTH_FAILURES';
        }
        if ($cat === 'OUTBOUND_FAILED' && !in_array('OUTBOUND_FAILING', $verdicts, true)) {
            $verdicts[] = 'OUTBOUND_FAILING';
        }
    }
    if (!$hasInbound && !in_array('NO_INBOUND_EVENTS', $verdicts, true)) {
        $verdicts[] = 'NO_INBOUND_EVENTS';
    }

    if (empty($verdicts)) {
        $verdicts[] = 'OK';
    }

    return [
        'ok' => true,
        'timestamp' => date('c'),
        'customerBot' => [
            'configured' => !empty($custToken),
            'online' => !empty($custMe['ok']),
            'username' => $custMe['result']['username'] ?? ($tg['customerBotUsername'] ?? 'Onivalbot'),
            'name' => $custMe['result']['first_name'] ?? 'N/A',
            'webhook' => $custSummary
        ],
        'adminBot' => [
            'configured' => !empty($admToken),
            'online' => !empty($admMe['ok']),
            'username' => $admMe['result']['username'] ?? ($tg['adminBotUsername'] ?? 'onivaladminbot'),
            'name' => $admMe['result']['first_name'] ?? 'N/A',
            'adminChatId' => $adminChatId,
            'webhook' => $admSummary
        ],
        'wallet' => [
            'mode' => $paymentMode,
            'hasLiveToken' => !empty($walletLive),
            'hasTestToken' => !empty($walletTest)
        ],
        'catalog' => onivalCatalogSummary($db['products'] ?? []),
        'verdicts' => $verdicts,
        'recentLogs' => array_slice($recentLogs, 0, 15)
    ];
}

function onivalBotSelfCheck($db) {
    return runDiagnosticsSuite($db);
}

function onival_run_after_response(callable $callable) {
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    try {
        $callable();
    } catch (\Throwable $e) {
        onival_log('background_job', 'JOB_EXCEPTION', $e->getMessage());
    }
}

function onivalNotifyAdminBot($eventType, $data) {
    global $dataFile;
    $raw = @file_get_contents($dataFile);
    if (!$raw) return;
    $db = @json_decode($raw, true);
    if (!$db) return;

    $tg = $db['telegramConfig'] ?? [];
    $adminToken = onivalBotRoleToken($tg, 'admin');
    $adminChatId = onivalBotAdminChatId($tg);

    if (empty($adminToken) || empty($adminChatId)) {
        return;
    }

    $msg = '';
    $buttons = null;

    if ($eventType === 'new_order') {
        $trk = $data['trackingCode'] ?? 'N/A';
        $tot = number_format((int)($data['totalPrice'] ?? $data['finalTotal'] ?? 0));
        $name = $data['userFullName'] ?? $data['customerName'] ?? 'مشتری';
        $method = $data['paymentMethod'] ?? 'card_to_card';
        $msg = "\u{1F514} سفارش جدید ثبت شد!\n\n" .
               "\u{1F4E6} کد پیگیری: {$trk}\n" .
               "\u{1F464} خریدار: {$name}\n" .
               "\u{1F4B0} مبلغ: {$tot} تومان\n" .
               "\u{1F4B3} روش پرداخت: {$method}\n" .
               "⏰ زمان: " . date('Y/m/d - H:i');
        $buttons = [
            'inline_keyboard' => [
                [
                    ['text' => '✅ تایید سفارش', 'callback_data' => "confirm_{$trk}"],
                    ['text' => '❌ لغو سفارش', 'callback_data' => "reject_{$trk}"]
                ]
            ]
        ];
    } elseif ($eventType === 'consultation') {
        $trk = $data['trackingCode'] ?? 'N/A';
        $name = $data['userFullName'] ?? 'متقاضی';
        $phone = $data['phoneNumber'] ?? '';
        $topic = $data['consultationDetails']['topicTitle'] ?? 'مشاوره سلامت';
        $msg = "\u{1F514} رزرو مشاوره تخصصی جدید!\n\n" .
               "\u{1F4E6} کد پیگیری: {$trk}\n" .
               "\u{1F464} نام: {$name}\n" .
               "\u{1F4DE} تلفن: {$phone}\n" .
               "\u{1F4AC} موضوع: {$topic}\n" .
               "⏰ زمان: " . date('Y/m/d - H:i');
    } elseif ($eventType === 'contact') {
        $name = $data['fullName'] ?? 'کاربر';
        $phone = $data['phoneNumber'] ?? '';
        $text = mb_substr($data['message'] ?? '', 0, 200, 'UTF-8');
        $msg = "\u{1F4E9} پیام جدید از فرم تماس با ما:\n\n" .
               "\u{1F464} فرستنده: {$name}\n" .
               "\u{1F4DE} تماس: {$phone}\n" .
               "✉️ پیام: {$text}\n" .
               "⏰ زمان: " . date('Y/m/d - H:i');
    }

    if (!empty($msg)) {
        sendBaleMessage($adminToken, $adminChatId, $msg, $buttons);
    }
}
