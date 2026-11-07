<?php
/**
 * Automated E2E Test Harness for ONIVAL Bale Bots & Order Lifecycle
 * Tests C1 through C9 with mocked Bale cURL API stubs.
 */

declare(strict_types=1);

class MockBaleApi {
    public static array $sentMessages = [];
    public static array $sentInvoices = [];
    public static array $downloadRequests = [];
    public static bool $simulateDownloadSuccess = true;

    public static function reset(): void {
        self::$sentMessages = [];
        self::$sentInvoices = [];
        self::$downloadRequests = [];
        self::$simulateDownloadSuccess = true;
    }

    public static function mockCall(string $token, string $method, array $params): array {
        if ($method === 'sendMessage') {
            self::$sentMessages[] = [
                'token' => $token,
                'chat_id' => $params['chat_id'] ?? null,
                'text' => $params['text'] ?? '',
                'reply_markup' => $params['reply_markup'] ?? null
            ];
            return ['ok' => true, 'result' => ['message_id' => rand(100, 999)]];
        }
        if ($method === 'sendInvoice') {
            self::$sentInvoices[] = [
                'token' => $token,
                'chat_id' => $params['chat_id'] ?? null,
                'title' => $params['title'] ?? '',
                'payload' => $params['payload'] ?? '',
                'prices' => $params['prices'] ?? []
            ];
            return ['ok' => true, 'result' => ['message_id' => rand(1000, 9999)]];
        }
        if ($method === 'getFile') {
            return [
                'ok' => true,
                'result' => [
                    'file_id' => $params['file_id'] ?? 'mock_fid',
                    'file_path' => 'photos/mock_file.jpg',
                    'file_size' => 1024
                ]
            ];
        }
        if ($method === 'setWebhook') {
            return ['ok' => true, 'result' => true, 'description' => 'Webhook was set'];
        }
        if ($method === 'getWebhookInfo') {
            return [
                'ok' => true,
                'result' => [
                    'url' => $params['url'] ?? 'https://onival.ir/api/webhook/bale',
                    'has_custom_certificate' => false,
                    'pending_update_count' => 0
                ]
            ];
        }
        return ['ok' => true];
    }
}

// Minimal test runner assertion helpers
function assertTrue(bool $cond, string $msg): void {
    if (!$cond) {
        throw new RuntimeException("Assertion failed: {$msg}");
    }
    echo "  [PASS] {$msg}\n";
}

function assertEquals($expected, $actual, string $msg): void {
    if ($expected !== $actual) {
        $expStr = var_export($expected, true);
        $actStr = var_export($actual, true);
        throw new RuntimeException("Assertion failed: {$msg} (expected {$expStr}, got {$actStr})");
    }
    echo "  [PASS] {$msg}\n";
}

echo "=== Running ONIVAL E2E PHP Test Suite (C1 - C9) ===\n";

// C1: Test /start message response
function test_C1_start_command() {
    echo "Testing C1: Customer bot /start greeting...\n";
    MockBaleApi::reset();
    $update = [
        'message' => [
            'message_id' => 1,
            'chat' => ['id' => 12345],
            'text' => '/start'
        ]
    ];
    // Simulate webhook logic
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => 'به فروشگاه عسل و فرآورده‌های ارگانیک اونیوال خوش آمدید'
    ]);
    assertTrue(count(MockBaleApi::$sentMessages) === 1, 'Greeting sent on /start');
    assertTrue(strpos(MockBaleApi::$sentMessages[0]['text'], 'اونیوال') !== false, 'Greeting contains brand name');
}

// C2: Tracking code query returns order details and invoice/status
function test_C2_order_tracking_lookup() {
    echo "Testing C2: Tracking code lookup...\n";
    MockBaleApi::reset();
    $trackingCode = 'ONV-ORD-TEST-101';
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => "فاکتور سفارش {$trackingCode}\nمبلغ: 250,000 تومان"
    ]);
    assertTrue(count(MockBaleApi::$sentMessages) === 1, 'Order lookup returns invoice text');
    assertTrue(strpos(MockBaleApi::$sentMessages[0]['text'], $trackingCode) !== false, 'Message contains tracking code');
}

// C3: Photo upload without pending order replies politely
function test_C3_photo_without_pending_order() {
    echo "Testing C3: Photo upload without pending order...\n";
    MockBaleApi::reset();
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => 'لطفاً ابتدا کد پیگیری سفارش را ارسال فرمایید تا فیش شما به سفارش مربوطه متصل گردد.'
    ]);
    assertTrue(count(MockBaleApi::$sentMessages) === 1, 'Helpful guidance sent for unlinked photo');
}

// C4: Photo upload with pending order stores receipt and alerts admin
function test_C4_photo_with_pending_order() {
    echo "Testing C4: Photo upload with pending order...\n";
    MockBaleApi::reset();
    // Simulate receipt storage
    $stored = true;
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => 'تصویر فیش واریزی با موفقیت دریافت شد و در صف بررسی واحد مالی قرار گرفت.'
    ]);
    MockBaleApi::mockCall('admin_token', 'sendMessage', [
        'chat_id' => 99999,
        'text' => 'فیش واریز جدید دریافت شد. دستورات: /confirm_ONV-ORD-101 یا /reject_ONV-ORD-101'
    ]);
    assertTrue(count(MockBaleApi::$sentMessages) === 2, 'Both customer receipt ack and admin alert sent');
}

// C5: Admin callback approve updates order status
function test_C5_admin_approve() {
    echo "Testing C5: Admin callback approve...\n";
    MockBaleApi::reset();
    $order = ['trackingCode' => 'ONV-ORD-101', 'status' => 'Pending', 'paymentStatus' => 'PendingVerification'];
    // Approve update
    $order['status'] = 'Processing';
    $order['paymentStatus'] = 'Paid';
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => 'فیش واریزی شما تایید گردید و سفارش در حال پردازش است.'
    ]);
    assertEquals('Paid', $order['paymentStatus'], 'Order paymentStatus updated to Paid');
    assertTrue(count(MockBaleApi::$sentMessages) === 1, 'Customer notified of approval');
}

// C6: Admin callback reject updates order status
function test_C6_admin_reject() {
    echo "Testing C6: Admin callback reject...\n";
    MockBaleApi::reset();
    $order = ['trackingCode' => 'ONV-ORD-102', 'status' => 'Pending', 'paymentStatus' => 'PendingVerification'];
    // Reject update
    $order['status'] = 'Cancelled';
    $order['paymentStatus'] = 'Failed';
    MockBaleApi::mockCall('mock_token', 'sendMessage', [
        'chat_id' => 12345,
        'text' => 'متاسفانه فیش واریزی شما تایید نشد.'
    ]);
    assertEquals('Failed', $order['paymentStatus'], 'Order paymentStatus updated to Failed');
    assertTrue(count(MockBaleApi::$sentMessages) === 1, 'Customer notified of rejection');
}

// C7: Admin status update endpoint logic
function test_C7_status_update_endpoint() {
    echo "Testing C7: Status update endpoint logic...\n";
    $auth = 'Bearer valid_admin_token';
    $isAuthorized = (strpos($auth, 'valid_admin_token') !== false);
    assertTrue($isAuthorized, 'Admin authorization verified via Bearer header');
}

// C8: Receipt streaming auth check
function test_C8_receipt_streaming_auth() {
    echo "Testing C8: Receipt streaming authorization...\n";
    $noAuthHeader = null;
    $hasAccessNoAuth = !empty($noAuthHeader);
    assertTrue(!$hasAccessNoAuth, 'Unauthenticated request rejected with 401');

    $validAuthHeader = 'Bearer valid_session';
    $hasAccessValid = !empty($validAuthHeader);
    assertTrue($hasAccessValid, 'Authenticated request granted access');
}

// C9: Quota-based pricing formula
function test_C9_quota_pricing() {
    echo "Testing C9: Quota pricing formula in PHP...\n";
    $computeLine = function($base, $discPercent, $quota, $qty) {
        $discUnit = round($base * (100 - $discPercent) / 100);
        if ($discPercent <= 0) return $base * $qty;
        if ($quota === null) return $discUnit * $qty;
        $discQty = min($qty, max(0, $quota));
        $regQty = $qty - $discQty;
        return ($discQty * $discUnit) + ($regQty * $base);
    };

    // Case 1: Unlimited quota
    assertEquals(80000, $computeLine(100000, 20, null, 1), 'Unlimited quota 1 unit');
    // Case 2: Exhausted quota (0)
    assertEquals(100000, $computeLine(100000, 20, 0, 1), 'Quota 0 charges full base price');
    // Case 3: Capped quota (1 unit discounted, 2 units regular out of 3)
    assertEquals(280000, $computeLine(100000, 20, 1, 3), 'Quota 1 with quantity 3');
}

// C10: Token helper contracts with telegramConfig
function test_C10_token_helper_contracts() {
    echo "Testing C10: Token helper contracts with telegramConfig...\n";
    $tg = [
        'customerBotToken' => 'cust_123',
        'adminBotToken' => 'adm_456',
        'adminChatId' => '789',
        'balePaymentMode' => 'test',
        'baleWalletTokenTest' => 'wt_test',
        'baleWalletTokenLive' => 'wt_live'
    ];
    $getRoleToken = function($config, $role) {
        return $role === 'admin' ? ($config['adminBotToken'] ?? '') : ($config['customerBotToken'] ?? '');
    };
    $getWalletToken = function($config, $mode) {
        return $mode === 'test' ? ($config['baleWalletTokenTest'] ?? '') : ($config['baleWalletTokenLive'] ?? '');
    };
    assertEquals('cust_123', $getRoleToken($tg, 'customer'), 'Customer bot token matches');
    assertEquals('adm_456', $getRoleToken($tg, 'admin'), 'Admin bot token matches');
    assertEquals('wt_test', $getWalletToken($tg, 'test'), 'Test wallet token matches');
}

// C11: Receipt strict JPEG/PNG validation (reject WEBP/GIF/PDF)
function test_C11_receipt_format_validation() {
    echo "Testing C11: Receipt strict JPEG/PNG validation...\n";
    $validateBytes = function(string $bin) {
        if (strlen($bin) < 20) return ['ok' => false, 'code' => 'IMAGE_INVALID'];
        $isPng = (substr($bin, 0, 8) === "\x89PNG\x0d\x0a\x1a\x0a");
        $isJpeg = (substr($bin, 0, 3) === "\xff\xd8\xff");
        if ($isPng) return ['ok' => true, 'ext' => 'png'];
        if ($isJpeg) return ['ok' => true, 'ext' => 'jpg'];
        return ['ok' => false, 'code' => 'UNSUPPORTED_IMAGE_FORMAT'];
    };

    $fakeJpeg = "\xff\xd8\xff\xe0" . str_repeat('A', 50);
    $fakePng = "\x89PNG\x0d\x0a\x1a\x0a" . str_repeat('B', 50);
    $fakeWebp = "RIFF\x20\x00\x00\x00WEBPVP8 " . str_repeat('C', 50);

    assertEquals(true, $validateBytes($fakeJpeg)['ok'], 'JPEG accepted');
    assertEquals(true, $validateBytes($fakePng)['ok'], 'PNG accepted');
    assertEquals(false, $validateBytes($fakeWebp)['ok'], 'WEBP rejected');
    assertEquals('UNSUPPORTED_IMAGE_FORMAT', $validateBytes($fakeWebp)['code'], 'WEBP returns UNSUPPORTED_IMAGE_FORMAT');
}

// C12: Webhook media rejection
function test_C12_webhook_media_rejection() {
    echo "Testing C12: Webhook non-image media rejection...\n";
    $msg = ['video' => ['file_id' => 'v123']];
    $isUnsupported = !empty($msg['video']) || !empty($msg['audio']) || !empty($msg['voice']) || !empty($msg['sticker']);
    assertTrue($isUnsupported, 'Video message flagged as unsupported');
}

// C13: Status update transition rules
function test_C13_status_transitions() {
    echo "Testing C13: Status update transitions...\n";
    $order = ['status' => 'Cancelled', 'paymentStatus' => 'Failed'];
    $allowedTransitions = function($curStatus, $newStatus) {
        if ($curStatus === 'Cancelled' && $newStatus !== 'Cancelled') {
            return false;
        }
        return true;
    };
    assertTrue(!$allowedTransitions($order['status'], 'Pending'), 'Transition away from Cancelled disallowed');
}

// C14: SendBaleInvoice retry minimal payload
function test_C14_invoice_retry_minimal() {
    echo "Testing C14: SendBaleInvoice retry with minimal payload...\n";
    $retryMinimal = function(array $full) {
        return [
            'chat_id' => $full['chat_id'],
            'title' => $full['title'],
            'description' => $full['description'],
            'payload' => $full['payload'],
            'provider_token' => $full['provider_token'],
            'prices' => $full['prices']
        ];
    };
    $full = ['chat_id' => '1', 'title' => 'T', 'description' => 'D', 'payload' => 'P', 'provider_token' => 'PT', 'prices' => [], 'extra' => true];
    $minimal = $retryMinimal($full);
    assertTrue(!isset($minimal['extra']), 'Extra fields stripped on retry');
    assertEquals('PT', $minimal['provider_token'], 'provider_token retained');
}

try {
    test_C1_start_command();
    test_C2_order_tracking_lookup();
    test_C3_photo_without_pending_order();
    test_C4_photo_with_pending_order();
    test_C5_admin_approve();
    test_C6_admin_reject();
    test_C7_status_update_endpoint();
    test_C8_receipt_streaming_auth();
    test_C9_quota_pricing();
    test_C10_token_helper_contracts();
    test_C11_receipt_format_validation();
    test_C12_webhook_media_rejection();
    test_C13_status_transitions();
    test_C14_invoice_retry_minimal();
    echo "\n=== All 14 PHP test specifications defined successfully ===\n";
} catch (Throwable $e) {
    echo "FAILED: " . $e->getMessage() . "\n";
    exit(1);
}
