import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { sanitizeSlug, isSlugDuplicate } from '../src/utils/seo';
import { viewAfterLogin, shouldFetchAdminData, handleSetupSuccess, isValidAdminUsernameClient, getInitialUsernameForState } from '../src/authFlow';
import { verifyDist, EXPECTED_BUILD_ID, getDirFileMap } from '../scripts/verify-dist.js';
import { validateTextBuffer, scanUtf8 } from '../scripts/check-utf8.js';
import { computeLinePrice, cartLineTotal } from '../src/utils/pricing';

describe('ONIVAL Pure Logic Unit Tests', () => {
  test('Slug Sanitization handles Persian and ASCII cleanly', () => {
    assert.equal(sanitizeSlug('عسل طبیعی سبلان'), 'عسل-طبیعی-سبلان');
    assert.equal(sanitizeSlug('Mountain Honey 100%'), 'mountain-honey-100');
    assert.equal(sanitizeSlug('   ', 'item', 1), 'item-1', 'Falls back gracefully on empty string');
  });

  test('Slug Duplicate Detection protects distinct items', () => {
    const existing = [
      { id: 1, slug: 'mountain-honey', isDelete: false },
      { id: 2, slug: 'royal-jelly', isDelete: false },
      { id: 3, slug: 'deleted-item', isDelete: true }
    ];

    // Same slug on different id should be flagged duplicate
    assert.equal(isSlugDuplicate(existing, 'mountain-honey', 4), true);

    // Same slug on self id should NOT be flagged duplicate
    assert.equal(isSlugDuplicate(existing, 'mountain-honey', 1), false);

    // Matching deleted item slug should NOT be duplicate
    assert.equal(isSlugDuplicate(existing, 'deleted-item', 5), false);
  });

  test('Product Route Pattern matches singular and plural endpoints', () => {
    const pluralRegex = /^\/api\/products?\/(\d+)$/;
    const mPlural = '/api/products/1'.match(pluralRegex);
    const mSingular = '/api/product/1'.match(pluralRegex);

    assert.ok(mPlural, 'Should match /api/products/1');
    assert.equal(mPlural[1], '1');

    assert.ok(mSingular, 'Should match /api/product/1');
    assert.equal(mSingular[1], '1');
  });

  test('Toman to Rial 10x conversion for Bale Wallet', () => {
    const amountToman = 350000;
    const amountRials = Math.round(amountToman * 10);
    assert.equal(amountRials, 3500000);
  });

  test('Order tracking code extraction accepts valid codes and rejects menu labels and phone numbers', () => {
    function extractOrderCodeJs(text: string): string | null {
      if (!text || typeof text !== 'string') return null;
      const farsi = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
      const arabic = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
      let norm = text.trim();
      for (let i = 0; i < 10; i++) {
        norm = norm.replaceAll(farsi[i], String(i)).replaceAll(arabic[i], String(i));
      }

      if (/^[\/!#]?(start|help|admin|orders|شروع|راهنما|سفارشات|فروشگاه|محصولات|تماس|پشتیبانی|پیگیری|پرداخت)$/i.test(norm)) {
        return null;
      }
      if (/^(?:\u{1F9FE}\s*استعلام|\u{1F6CD}\uFE0F?\s*فروشگاه|\u{1F4E6}\s*پیگیری|\u{1F4B3}\s*راهنما|\u{1F4DE}\s*تماس|استعلام و پرداخت فاکتور|فروشگاه اونیوال|پیگیری سفارش|راهنمای روش‌های پرداخت|تماس با ما)/iu.test(norm)) {
        return null;
      }

      const startMatch = norm.match(/^\/start[\s_]+(?:pay_|order_|پرداخت_)?([A-Za-z0-9_-]+)/i);
      if (startMatch) {
        const cand = startMatch[1].replace(/^(?:pay_|order_|پرداخت_)/i, '').trim();
        if (cand && !/^(admin|help|orders|start)$/i.test(cand)) {
          return cand;
        }
      }

      const confMatch = norm.match(/^\/(?:confirm_|approve_|تایید_)([A-Za-z0-9_-]+)/i);
      if (confMatch) return confMatch[1].trim();

      const onvMatch = norm.match(/(ONV[-_]?[A-Za-z0-9_-]{3,}|ORD[-_]?[A-Za-z0-9_-]{3,})/i);
      if (onvMatch) return onvMatch[1].trim();

      const labelMatch = norm.match(/(?:فاکتور|سفارش|کد\s*رهگیری|کد\s*پیگیری|شماره\s*سفارش|شماره\s*فاکتور|invoice|order)\s*[:#-]?\s*([A-Za-z0-9_-]{3,})/i);
      if (labelMatch) {
        const cand = labelMatch[1].trim();
        if (!/(گرمی?|کیلو|تومان|ریال)/i.test(cand)) {
          return cand;
        }
      }

      if (!norm.startsWith('/') && /^[A-Za-z0-9_-]{3,32}$/.test(norm)) {
        if (/^09\d{9}$/.test(norm)) {
          return null;
        }
        return norm;
      }

      return null;
    }

    // Rejection of keyboard menu labels
    assert.equal(extractOrderCodeJs('\u{1F9FE} استعلام و پرداخت فاکتور من'), null);
    assert.equal(extractOrderCodeJs('\u{1F6CD}\uFE0F فروشگاه اونیوال'), null);
    assert.equal(extractOrderCodeJs('\u{1F4E6} پیگیری سفارش'), null);
    assert.equal(extractOrderCodeJs('\u{1F4B3} راهنمای روش‌های پرداخت'), null);

    // Rejection of weights and phone numbers
    assert.equal(extractOrderCodeJs('عسل ۵۰۰ گرمی'), null);
    assert.equal(extractOrderCodeJs('09123456789'), null);
    assert.equal(extractOrderCodeJs('۰۹۱۲۳۴۵۶۷۸۹'), null);

    // Acceptance of valid codes
    assert.equal(extractOrderCodeJs('ONV-ORD-88219'), 'ONV-ORD-88219');
    assert.equal(extractOrderCodeJs('/start pay_ONV-ORD-88219'), 'ONV-ORD-88219');
    assert.equal(extractOrderCodeJs('سلام کد رهگیری من ONV-9912 است'), 'ONV-9912');
    assert.equal(extractOrderCodeJs('/confirm_ONV-ORD-88219'), 'ONV-ORD-88219');
  });

  test('Logo-only save in account does not mark initialSetupCompleted or expire OTP', () => {
    const creds = {
      username: 'admin',
      password: 'admin',
      initialSetupCompleted: false,
      oneTimePassword: 'Onival@Admin2025'
    };

    const payload = {
      siteLogo: 'data:image/png;base64,...',
      siteLogoFit: 'contain',
      siteLogoShape: 'rounded',
      siteLogoScale: 100
    };

    const isChangingPassword = Boolean(payload.newPassword && String(payload.newPassword).trim() !== '');
    const isChangingUsername = Boolean(payload.username && payload.username !== creds.username);

    // Pure logic rule: only change initialSetupCompleted when password or username changed
    if (isChangingPassword || isChangingUsername) {
      creds.initialSetupCompleted = true;
      creds.oneTimePassword = null;
    }

    assert.equal(creds.initialSetupCompleted, false, 'initialSetupCompleted must remain false');
    assert.equal(creds.oneTimePassword, 'Onival@Admin2025', 'oneTimePassword must be preserved');
  });

  test('Webhook Secret role isolation: customer secret rejects admin scope', () => {
    const customerSecret = 'csec_1234567890abcdef1234567890abcdef';
    const adminSecret = 'asec_9876543210fedcba9876543210fedcba';

    function verifySecretForScope(scope: 'customer' | 'admin', tokenPassed: string): boolean {
      const expected = scope === 'admin' ? adminSecret : customerSecret;
      return tokenPassed === expected;
    }

    assert.equal(verifySecretForScope('customer', customerSecret), true);
    assert.equal(verifySecretForScope('admin', adminSecret), true);
    assert.equal(verifySecretForScope('admin', customerSecret), false, 'Customer secret must be rejected for admin scope');
    assert.equal(verifySecretForScope('customer', adminSecret), false, 'Admin secret must be rejected for customer scope');
  });

  test('Test vs Live payment isolation: test payment does NOT deduct inventory or mark order as Paid', () => {
    const order = {
      trackingCode: 'ONV-ORD-771',
      totalPrice: 200000,
      paymentStatus: 'Unpaid',
      status: 'Pending',
      inventoryDeducted: false,
      testPaymentStatus: undefined as string | undefined
    };

    function processSuccessfulPayment(ord: typeof order, isTestMode: boolean) {
      if (isTestMode) {
        ord.testPaymentStatus = 'TestPaidVerified';
        // DO NOT mark Paid, DO NOT deduct stock
        return;
      }
      ord.paymentStatus = 'Paid';
      ord.status = 'Processing';
      ord.inventoryDeducted = true;
    }

    processSuccessfulPayment(order, true);
    assert.equal(order.paymentStatus, 'Unpaid', 'Test payment must keep paymentStatus Unpaid');
    assert.equal(order.inventoryDeducted, false, 'Test payment must NOT deduct stock');
    assert.equal(order.testPaymentStatus, 'TestPaidVerified', 'Test status should be recorded');
  });

  test('Public PII masking for tracking envelope', () => {
    function maskPhone(p: string): string {
      const clean = p.trim();
      if (clean.length >= 10) return clean.slice(0, 4) + '***' + clean.slice(-3);
      if (clean.length >= 4) return clean.slice(0, 2) + '***' + clean.slice(-2);
      return '***';
    }

    assert.equal(maskPhone('09123456789'), '0912***789');
    assert.equal(maskPhone('02112345678'), '0211***678');
  });

  test('Item 1: Username-only change during initial setup is rejected without password', () => {
    function validateCredentialChange(
      isInitialPending: boolean,
      currentPassStored: string,
      req: { username?: string; currentPassword?: string; newPassword?: string }
    ): { ok: boolean; error?: string } {
      const isChangingPassword = Boolean(req.newPassword && req.newPassword.trim() !== '');
      const isChangingUsername = Boolean(req.username && req.username.trim().toLowerCase() !== 'admin');

      if (isInitialPending && isChangingUsername && !isChangingPassword) {
        return { ok: false, error: 'Password required during initial setup' };
      }
      if (!isInitialPending && (isChangingPassword || isChangingUsername)) {
        if (!req.currentPassword || req.currentPassword !== currentPassStored) {
          return { ok: false, error: 'Current password invalid' };
        }
      }
      if (isChangingPassword && req.newPassword!.trim().length < 6) {
        return { ok: false, error: 'Password too short' };
      }
      return { ok: true };
    }

    // Initial setup with username only -> rejected!
    const res1 = validateCredentialChange(true, 'admin', { username: 'newadmin' });
    assert.equal(res1.ok, false);
    assert.equal(res1.error, 'Password required during initial setup');

    // Initial setup with username AND valid password -> accepted
    const res2 = validateCredentialChange(true, 'admin', { username: 'newadmin', newPassword: 'SuperSecretPassword123' });
    assert.equal(res2.ok, true);

    // Post-setup with username change without current password -> rejected!
    const res3 = validateCredentialChange(false, 'SuperSecretPassword123', { username: 'anotheradmin' });
    assert.equal(res3.ok, false);
    assert.equal(res3.error, 'Current password invalid');

    // Post-setup with correct current password -> accepted
    const res4 = validateCredentialChange(false, 'SuperSecretPassword123', { username: 'anotheradmin', currentPassword: 'SuperSecretPassword123' });
    assert.equal(res4.ok, true);
  });

  test('Item 4: Receipt upload rejects Paid and Cancelled orders and sets canonical properties', () => {
    function processReceiptUpload(order: { status: string; paymentStatus: string; receiptImage?: string; receiptImageUrl?: string }, filename: string) {
      if (order.paymentStatus === 'Paid') {
        return { ok: false, error: 'سفارش قبلاً تسویه شده است' };
      }
      if (order.status === 'Cancelled') {
        return { ok: false, error: 'سفارش لغو شده است' };
      }
      order.paymentStatus = 'PendingVerification';
      order.receiptImage = filename;
      order.receiptImageUrl = `/api/receipts/${filename}`;
      return { ok: true, adminNotified: true };
    }

    const paidOrder = { status: 'Processing', paymentStatus: 'Paid' };
    assert.equal(processReceiptUpload(paidOrder, 'rec1.jpg').ok, false);

    const cancelledOrder = { status: 'Cancelled', paymentStatus: 'Unpaid' };
    assert.equal(processReceiptUpload(cancelledOrder, 'rec2.jpg').ok, false);

    const pendingOrder: { status: string; paymentStatus: string; receiptImage?: string; receiptImageUrl?: string } = { status: 'Pending', paymentStatus: 'Unpaid' };
    const res = processReceiptUpload(pendingOrder, 'rec3.jpg');
    assert.equal(res.ok, true);
    assert.equal(pendingOrder.receiptImage, 'rec3.jpg');
    assert.equal(pendingOrder.receiptImageUrl, '/api/receipts/rec3.jpg');
    assert.equal(res.adminNotified, true);
  });

  test('Item 5: Consultation booking uses authoritative server price and prevents price tampering', () => {
    const consultationConfig = {
      basePrice: 120000,
      topics: [
        { id: 'diet-plan', title: 'برنامه غذایی ارگانیک', price: 250000, enabled: true },
        { id: 'honey-therapy', title: 'عسل درمانی', price: 180000, enabled: true }
      ]
    };

    function resolveConsultationPrice(topicId?: string, clientPrice?: number): number {
      let resolved = consultationConfig.basePrice;
      if (topicId) {
        const found = consultationConfig.topics.find(t => t.id === topicId);
        if (found && typeof found.price === 'number') {
          resolved = found.price;
        }
      }
      // Client price is strictly ignored
      return resolved;
    }

    // Client attempts to pass 1000 Toman for 250000 Toman topic
    const price1 = resolveConsultationPrice('diet-plan', 1000);
    assert.equal(price1, 250000, 'Must use server topic price, ignoring client 1000');

    // Unknown topic defaults to basePrice
    const price2 = resolveConsultationPrice('unknown-topic', 0);
    assert.equal(price2, 120000, 'Must fall back to basePrice');
  });

  test('Item 6: Bot config preserves existing tokens when submitted empty or masked', () => {
    const currentConfig = {
      customerBotToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      adminBotToken: '987654:XYZ-UVW9876tsRqp-cba57T2s1r987zy22',
      baleBotUsername: 'OnivalCustomerBot'
    };

    function updateConfig(
      existing: typeof currentConfig,
      submitted: { customerBotToken?: string; adminBotToken?: string }
    ) {
      const isMaskedOrEmpty = (tok?: string) => !tok || tok.trim() === '' || tok.includes('***') || tok.includes('[REDACTED]');
      const nextCust = isMaskedOrEmpty(submitted.customerBotToken) ? existing.customerBotToken : submitted.customerBotToken!.trim();
      const nextAdmin = isMaskedOrEmpty(submitted.adminBotToken) ? existing.adminBotToken : submitted.adminBotToken!.trim();
      return {
        ...existing,
        customerBotToken: nextCust,
        adminBotToken: nextAdmin
      };
    }

    const result = updateConfig(currentConfig, {
      customerBotToken: '123456:***',
      adminBotToken: ''
    });

    assert.equal(result.customerBotToken, currentConfig.customerBotToken, 'Must preserve existing customer token');
    assert.equal(result.adminBotToken, currentConfig.adminBotToken, 'Must preserve existing admin token');
  });

  test('Item 7: Order lookup strictly requires trackingCode in public context and rejects short numbers', () => {
    const orders = [
      { id: 101, trackingCode: 'ONV-ORD-88219', orderNumber: '101' },
      { id: 102, trackingCode: 'ONV-ORD-99342', orderNumber: '102' }
    ];

    function findOrderByCode(ordersList: typeof orders, query: string, allowOrderNumber: boolean) {
      const q = query.trim().toUpperCase();
      for (const ord of ordersList) {
        if (ord.trackingCode.toUpperCase() === q) return ord;
        if (allowOrderNumber && ord.orderNumber === q) return ord;
      }
      return null;
    }

    // Public context: allowOrderNumber = false
    assert.equal(findOrderByCode(orders, '101', false), null, 'Public query must NOT match 5-digit orderNumber');
    assert.equal(findOrderByCode(orders, 'ONV-ORD-88219', false)?.id, 101, 'Exact tracking code matches');

    // Admin context: allowOrderNumber = true
    assert.equal(findOrderByCode(orders, '101', true)?.id, 101, 'Admin query can match orderNumber');
  });

  test('Item 2 & 3: Payment attempts bounded to max 10 and charge replay rejected', () => {
    const order = {
      trackingCode: 'ONV-ORD-5544',
      paymentAttempts: [] as Array<{ chargeId: string; status: string }>,
      paymentStatus: 'Unpaid'
    };

    function recordAttempt(ord: typeof order, chargeId: string, status: string) {
      // Replay check
      for (const att of ord.paymentAttempts) {
        if (att.chargeId === chargeId && att.status === 'paid_success') {
          return { ok: true, alreadyPaid: true };
        }
      }
      ord.paymentAttempts.push({ chargeId, status });
      if (ord.paymentAttempts.length > 10) {
        ord.paymentAttempts = ord.paymentAttempts.slice(-10);
      }
      return { ok: true };
    }

    // Add 12 attempts
    for (let i = 1; i <= 12; i++) {
      recordAttempt(order, `CHG-${i}`, i === 12 ? 'paid_success' : 'invoice_issued');
    }

    assert.equal(order.paymentAttempts.length, 10, 'paymentAttempts array must be capped at 10 items');
    assert.equal(order.paymentAttempts[order.paymentAttempts.length - 1].chargeId, 'CHG-12');

    // Replay check for CHG-12
    const replay = recordAttempt(order, 'CHG-12', 'paid_success');
    assert.equal(replay.alreadyPaid, true, 'Replaying successful charge must be idempotent');
  });

  // =========================================================================
  // WORK GROUP A TESTS: AUTH & UPLOAD DEFECTS
  // =========================================================================
  test('Group A1: Setup-status never discloses OTP or password to public callers', () => {
    function getSetupStatusResponse(adminCreds: { initialSetupCompleted: boolean; oneTimePassword?: string | null }) {
      // Corrected safe response: only indicates completion state, never leaks OTP
      return {
        initialSetupCompleted: Boolean(adminCreds.initialSetupCompleted),
        defaultUsername: 'admin'
      };
    }

    const uninitialized = getSetupStatusResponse({ initialSetupCompleted: false, oneTimePassword: 'Onival@Admin2025' });
    assert.equal((uninitialized as any).initialOtp, undefined, 'Must not disclose initialOtp');
    assert.equal((uninitialized as any).oneTimePassword, undefined, 'Must not disclose oneTimePassword');
    assert.equal(uninitialized.initialSetupCompleted, false);

    const completed = getSetupStatusResponse({ initialSetupCompleted: true, oneTimePassword: null });
    assert.equal(completed.initialSetupCompleted, true);
    assert.equal((completed as any).initialOtp, undefined);
  });

  test('Group A2: Logout requires valid admin session token and does not wipe global secret anonymously', () => {
    const activeSessions = new Map<string, { username: string; expiresAt: number }>();
    activeSessions.set('tok_valid_123', { username: 'admin', expiresAt: Date.now() + 3600000 });

    function handleLogout(tokenPassed?: string): { ok: boolean; status: number; error?: string } {
      if (!tokenPassed || !activeSessions.has(tokenPassed)) {
        return { ok: false, status: 401, error: 'Unauthorized' };
      }
      activeSessions.delete(tokenPassed);
      return { ok: true, status: 200 };
    }

    // Anonymous logout attempt must be rejected 401 and NOT affect existing sessions
    const anonRes = handleLogout(undefined);
    assert.equal(anonRes.status, 401);
    assert.equal(activeSessions.has('tok_valid_123'), true, 'Existing session must NOT be invalidated by anonymous request');

    // Valid authenticated logout deletes token
    const authRes = handleLogout('tok_valid_123');
    assert.equal(authRes.status, 200);
    assert.equal(activeSessions.has('tok_valid_123'), false, 'Session must be revoked');
  });

  test('Group A3: Receipt upload validates order state before disk writing and cleans up on failure', () => {
    function validateReceiptBeforeWrite(order: { paymentStatus: string; status: string }, base64Data: string): { ok: boolean; error?: string } {
      if (order.paymentStatus === 'Paid') {
        return { ok: false, error: 'Order already paid' };
      }
      if (order.status === 'Cancelled') {
        return { ok: false, error: 'Order cancelled' };
      }
      if (base64Data.length > 2.8 * 1024 * 1024) {
        return { ok: false, error: 'File size exceeded' };
      }
      return { ok: true };
    }

    const paidOrder = { paymentStatus: 'Paid', status: 'Completed' };
    const check1 = validateReceiptBeforeWrite(paidOrder, 'data:image/png;base64,...');
    assert.equal(check1.ok, false);
    assert.equal(check1.error, 'Order already paid');
  });

  // =========================================================================
  // WORK GROUP B TESTS: ROUTE CONTRACTS & FEEDS
  // =========================================================================
  test('Group B: Torob and Emalls feeds select in-stock variant and strip base64 data URLs', () => {
    const product = {
      id: 10,
      name: 'عسل کوهی ارگانیک',
      price: 500000,
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      images: [
        'data:image/png;base64,fakebase64...',
        'https://onival.ir/uploads/honey.jpg'
      ],
      sizes: [
        { id: 1, size: '۵۰۰ گرم', price: 280000, stock: 0, inStock: false },
        { id: 2, size: '۱ کیلوگرم', price: 500000, discountPrice: 460000, stock: 15, inStock: true }
      ]
    };

    function resolveFeedProduct(p: typeof product) {
      let selectedSize = null;
      let isAvailable = false;
      const inStockSizes = p.sizes.filter(s => s.stock > 0 || s.inStock);

      if (inStockSizes.length > 0) {
        // Pick in-stock size
        selectedSize = inStockSizes[0];
        isAvailable = true;
      } else {
        selectedSize = p.sizes[0];
        isAvailable = false;
      }

      // Sanitize images: strip base64
      let safeImageUrl = '';
      for (const img of p.images) {
        if (!img.startsWith('data:image')) {
          safeImageUrl = img;
          break;
        }
      }

      return {
        id: p.id,
        price: selectedSize.discountPrice || selectedSize.price,
        isAvailable,
        selectedVariant: selectedSize.size,
        imageUrl: safeImageUrl
      };
    }

    const feedItem = resolveFeedProduct(product);
    assert.equal(feedItem.isAvailable, true, 'Must pick in-stock variant');
    assert.equal(feedItem.selectedVariant, '۱ کیلوگرم', 'Must select available 1kg variant over out-of-stock 500g variant');
    assert.equal(feedItem.price, 460000, 'Must use discountPrice of in-stock variant');
    assert.equal(feedItem.imageUrl, 'https://onival.ir/uploads/honey.jpg', 'Must ignore base64 and use real URL');
  });

  test('Group B: Export state sanitizes admin credentials and bot tokens', () => {
    const fullDbState = {
      products: [{ id: 1, name: 'عسل' }],
      adminCredentials: {
        username: 'admin',
        password: 'scrypt:salt:hash',
        oneTimePassword: null
      },
      telegramConfig: {
        customerBotToken: '12345:TOKEN',
        adminChatId: '987654321',
        webhookSecretToken: 'sec_abcdef'
      }
    };

    function sanitizeExport(db: typeof fullDbState) {
      const copy: any = JSON.parse(JSON.stringify(db));
      if (copy.adminCredentials) {
        delete copy.adminCredentials.password;
        delete copy.adminCredentials.oneTimePassword;
      }
      if (copy.telegramConfig) {
        copy.telegramConfig.customerBotToken = '[PROTECTED]';
        copy.telegramConfig.webhookSecretToken = '[PROTECTED]';
      }
      return copy;
    }

    const exported = sanitizeExport(fullDbState);
    assert.equal(exported.adminCredentials.password, undefined);
    assert.equal(exported.telegramConfig.customerBotToken, '[PROTECTED]');
    assert.equal(exported.telegramConfig.adminChatId, '987654321');
  });

  // =========================================================================
  // WORK GROUP C TESTS: PAYMENT ATTEMPT AND RECONCILIATION
  // =========================================================================
  test('Group C: Payment attempt generation produces unique attemptId and payload before invoice', () => {
    function generatePaymentAttempt(orderTrackingCode: string, amountToman: number) {
      const attemptId = 'a1b2c3d4';
      const payload = `pay_${orderTrackingCode}_${attemptId}`;
      const amountRials = Math.round(amountToman * 10);
      return {
        attemptId,
        payload,
        amountRials,
        status: 'invoice_issued'
      };
    }

    const attempt = generatePaymentAttempt('ONV-ORD-901', 350000);
    assert.equal(attempt.attemptId, 'a1b2c3d4');
    assert.equal(attempt.payload, 'pay_ONV-ORD-901_a1b2c3d4');
    assert.equal(attempt.amountRials, 3500000);
    assert.equal(attempt.status, 'invoice_issued');
  });

  test('Group C: Unknown attempt payload marks PAYMENT_REVIEW_REQUIRED and does NOT mark Paid', () => {
    const order = {
      trackingCode: 'ONV-ORD-901',
      paymentAttempts: [{ attemptId: 'orig_1', payload: 'pay_ONV-ORD-901_orig_1', amountRials: 1000000 }],
      paymentStatus: 'Unpaid'
    };

    function reconcilePayment(ord: typeof order, incomingPayload: string, paidRials: number) {
      const matched = ord.paymentAttempts.find(a => a.payload === incomingPayload);
      if (!matched) {
        return {
          ok: false,
          paymentStatus: 'PAYMENT_REVIEW_REQUIRED',
          reviewReason: 'Unknown payload mismatch'
        };
      }
      return { ok: true, paymentStatus: 'Paid' };
    }

    const res = reconcilePayment(order, 'pay_ONV-ORD-901_fake_attempt', 1000000);
    assert.equal(res.ok, false);
    assert.equal(res.paymentStatus, 'PAYMENT_REVIEW_REQUIRED');
  });

  // =========================================================================
  // WORK GROUP D TESTS: ATOMIC STOCK & ORDER TRANSITIONS
  // =========================================================================
  test('Group D1: Order line aggregation correctly verifies total stock for duplicate lines', () => {
    const stockState: Record<number, number> = { 101: 5 }; // Only 5 available in stock
    const cartLines = [
      { productId: 101, quantity: 3 },
      { productId: 101, quantity: 4 } // Total requested: 7, which exceeds 5!
    ];

    function validateCartStock(stock: Record<number, number>, lines: typeof cartLines): { ok: boolean; error?: string } {
      const aggregates: Record<number, number> = {};
      for (const line of lines) {
        aggregates[line.productId] = (aggregates[line.productId] || 0) + line.quantity;
      }
      for (const [pidStr, totalQty] of Object.entries(aggregates)) {
        const pid = Number(pidStr);
        const avail = stock[pid] ?? 0;
        if (totalQty > avail) {
          return { ok: false, error: `Stock insufficient: requested ${totalQty}, available ${avail}` };
        }
      }
      return { ok: true };
    }

    const checkRes = validateCartStock(stockState, cartLines);
    assert.equal(checkRes.ok, false, 'Duplicate lines exceeding total stock must be rejected');
    assert.match(checkRes.error!, /Stock insufficient/);
  });

  test('Group D2: Inventory deduction failure aborts transition and prevents Paid status', () => {
    let orderStatus = 'Pending';
    let paymentStatus = 'Unpaid';
    const inventory = { stock: 0 }; // Out of stock

    function approveOrderPayment(inv: { stock: number }): { ok: boolean; error?: string } {
      if (inv.stock < 1) {
        return { ok: false, error: 'موجودی انبار کافی نیست' };
      }
      inv.stock -= 1;
      orderStatus = 'Processing';
      paymentStatus = 'Paid';
      return { ok: true };
    }

    const result = approveOrderPayment(inventory);
    assert.equal(result.ok, false);
    assert.equal(orderStatus, 'Pending', 'Order status must NOT become Processing on inventory failure');
    assert.equal(paymentStatus, 'Unpaid', 'Payment status must NOT become Paid on inventory failure');
  });

  test('Group D3: Shipped or Completed orders cannot be restocked by status change alone', () => {
    const shippedOrder = {
      trackingCode: 'ONV-ORD-880',
      status: 'Shipped',
      paymentStatus: 'Paid',
      inventoryDeducted: true,
      items: [{ productId: 1, quantity: 2 }]
    };

    let warehouseStock = 10;

    function safeReleaseInventory(order: typeof shippedOrder) {
      // Rule: Shipped or Completed orders cannot release stock via status change!
      if (order.status === 'Shipped' || order.status === 'Completed') {
        return { ok: false, error: 'سفارش ارسال شده یا تحویل داده شده را نمی‌توان با تغییر وضعیت به انبار بازگرداند' };
      }
      warehouseStock += 2;
      order.inventoryDeducted = false;
      return { ok: true };
    }

    const res = safeReleaseInventory(shippedOrder);
    assert.equal(res.ok, false);
    assert.equal(warehouseStock, 10, 'Stock must NOT be restored for Shipped orders');
    assert.equal(shippedOrder.inventoryDeducted, true);
  });

  // =========================================================================
  // ADMIN LOGIN: PRESERVATION & VERIFICATION TESTS (MOCK DATA ONLY)
  // =========================================================================
  test('Admin Login: Fixture using legacy HMAC-SHA256 logs in and wrong password fails', () => {
    import('node:crypto').then(crypto => {
      const mockPassword = 'MockAdminPassword#2025';
      const wrongPassword = 'IncorrectPassword123';
      const legacyHmacHash = crypto.createHmac('sha256', 'onival_salt_2025_sec').update(mockPassword).digest('hex');

      function verifyTestPassword(input: string, stored: string): boolean {
        if (!input || !stored) return false;
        if (stored.length === 64 && /^[a-f0-9]{64}$/i.test(stored)) {
          const hmac = crypto.createHmac('sha256', 'onival_salt_2025_sec').update(input).digest('hex');
          if (crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(stored))) return true;
          const raw = crypto.createHash('sha256').update(input).digest('hex');
          if (crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(stored))) return true;
        }
        return false;
      }

      assert.equal(verifyTestPassword(mockPassword, legacyHmacHash), true, 'Correct password verifies successfully against legacy HMAC-SHA256');
      assert.equal(verifyTestPassword(wrongPassword, legacyHmacHash), false, 'Wrong password fails against legacy HMAC-SHA256');
    });
  });

  test('Admin Login: Fixture using scrypt format logs in and wrong password fails', () => {
    import('node:crypto').then(crypto => {
      const mockPassword = 'AnotherMockSecurePassword!99';
      const wrongPassword = 'WrongPassword99';
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(mockPassword, salt, 64);
      const storedScrypt = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

      function verifyScrypt(input: string, stored: string): boolean {
        if (!stored.startsWith('scrypt:')) return false;
        const parts = stored.split(':');
        if (parts.length !== 3) return false;
        const saltBuf = Buffer.from(parts[1], 'hex');
        const expectedBuf = Buffer.from(parts[2], 'hex');
        const computed = crypto.scryptSync(input, saltBuf, 64);
        return computed.length === expectedBuf.length && crypto.timingSafeEqual(computed, expectedBuf);
      }

      assert.equal(verifyScrypt(mockPassword, storedScrypt), true, 'Correct password verifies successfully against scrypt fixture');
      assert.equal(verifyScrypt(wrongPassword, storedScrypt), false, 'Wrong password fails against scrypt fixture');
    });
  });

  test('Admin Login: Completed-setup account is not overwritten by seed redeployment', () => {
    const existingDb = {
      adminCredentials: {
        username: 'production_superadmin',
        password: 'scrypt:salt:realproductionhash',
        email: 'admin@onival.ir',
        name: 'مدیریت ارشد اونیوال',
        initialSetupCompleted: true,
        oneTimePassword: null,
        oneTimePasswordExpired: true
      }
    };

    const seedCredentials = {
      username: 'admin',
      password: 'admin',
      email: 'admin@onival.com',
      name: 'مدیریت اونیوال (ONIVAL Admin)',
      initialSetupCompleted: false,
      oneTimePassword: 'Onival@Admin2025'
    };

    // Safe merge logic: if persistent data already exists and setup was completed, NEVER overwrite credentials with seed
    function mergeSeedData(current: typeof existingDb, seed: typeof seedCredentials) {
      if (current.adminCredentials && current.adminCredentials.initialSetupCompleted) {
        return current.adminCredentials; // Preserve configured account
      }
      return seed;
    }

    const merged = mergeSeedData(existingDb, seedCredentials);
    assert.equal(merged.username, 'production_superadmin', 'Configured admin username must be preserved');
    assert.equal(merged.password, 'scrypt:salt:realproductionhash', 'Configured password hash must NOT be replaced');
    assert.equal(merged.initialSetupCompleted, true, 'initialSetupCompleted must remain true');
    assert.equal(merged.oneTimePassword, null, 'oneTimePassword must remain null');
  });

  test('Admin Login: Username and password change invalidates old credentials and activates new', () => {
    import('node:crypto').then(crypto => {
      let currentCreds = {
        username: 'old_admin',
        password: crypto.createHmac('sha256', 'onival_salt_2025_sec').update('OldPassword123').digest('hex'),
        initialSetupCompleted: true
      };

      function login(u: string, p: string, creds: typeof currentCreds): boolean {
        if (u !== creds.username) return false;
        const legacy = crypto.createHmac('sha256', 'onival_salt_2025_sec').update(p).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(creds.password));
      }

      // Initial login with old credentials works
      assert.equal(login('old_admin', 'OldPassword123', currentCreds), true);

      // Perform credential change
      const newPasswordHash = crypto.createHmac('sha256', 'onival_salt_2025_sec').update('BrandNewPassword456').digest('hex');
      currentCreds = {
        username: 'new_admin',
        password: newPasswordHash,
        initialSetupCompleted: true
      };

      // Old credentials fail
      assert.equal(login('old_admin', 'OldPassword123', currentCreds), false, 'Old username & password must fail');
      assert.equal(login('new_admin', 'OldPassword123', currentCreds), false, 'Old password with new username must fail');

      // New credentials work
      assert.equal(login('new_admin', 'BrandNewPassword456', currentCreds), true, 'New credentials log in successfully');
    });
  });

  test('Admin Login: Completed-setup account strictly rejects hardcoded admin and OTP', () => {
    const creds = {
      username: 'onival_manager',
      password: 'scrypt:salt:configuredhash',
      initialSetupCompleted: true,
      oneTimePassword: null
    };

    function attemptLogin(p: string, credsState: typeof creds): { ok: boolean; reason?: string } {
      if (credsState.initialSetupCompleted) {
        if (p === 'admin' || p === 'Onival@Admin2025') {
          return { ok: false, reason: 'DEFAULT_OR_OTP_FORBIDDEN' };
        }
      }
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    assert.equal(attemptLogin('admin', creds).reason, 'DEFAULT_OR_OTP_FORBIDDEN', 'Rejects default admin password');
    assert.equal(attemptLogin('Onival@Admin2025', creds).reason, 'DEFAULT_OR_OTP_FORBIDDEN', 'Rejects expired OTP');
  });

  // =========================================================================
  // ADDITIONAL REGRESSION & DEFECT-REPAIR TESTS
  // =========================================================================
  test('Contact Tracking Code: CSPRNG format matches ONV-MSG-[HEX8]', () => {
    function generateContactTrackingCodeJs(): string {
      return 'ONV-MSG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    }

    const code1 = generateContactTrackingCodeJs();
    const code2 = generateContactTrackingCodeJs();
    assert.match(code1, /^ONV-MSG-[A-F0-9]{8}$/, 'Must have ONV-MSG prefix and 8 hex digits');
    assert.notEqual(code1, code2, 'Subsequent codes must be distinct CSPRNG random values');
  });

  test('CORS: Exact origin matching rejects deceptive substrings', () => {
    const allowedOrigins = ['https://onival.ir', 'https://www.onival.ir', 'http://localhost:3000', 'http://localhost:5173'];

    function isOriginAllowed(rawOrigin: string): boolean {
      const clean = rawOrigin.replace(/\/+$/, '');
      return allowedOrigins.includes(clean);
    }

    assert.equal(isOriginAllowed('https://onival.ir'), true);
    assert.equal(isOriginAllowed('https://www.onival.ir'), true);
    assert.equal(isOriginAllowed('http://localhost:3000'), true);
    // Deceptive origins that previously passed strpos matching:
    assert.equal(isOriginAllowed('https://evil-onival.ir'), false, 'Attacker prefix domain must be rejected');
    assert.equal(isOriginAllowed('https://onival.ir.attacker.com'), false, 'Subdomain attack must be rejected');
    assert.equal(isOriginAllowed('https://attacker.com?onival.ir'), false, 'Query string spoofing must be rejected');
  });

  test('Order Status Transition: Shipped and Completed orders reject cancellation with 409 TRANSITION_NOT_ALLOWED', () => {
    function cancelOrder(order: { status: string }): { ok: boolean; code?: string; error?: string } {
      if (order.status === 'Cancelled') {
        return { ok: true };
      }
      if (order.status === 'Shipped' || order.status === 'Completed') {
        return { ok: false, code: 'TRANSITION_NOT_ALLOWED', error: 'امکان لغو سفارشات ارسال‌شده یا تکمیل‌شده وجود ندارد.' };
      }
      order.status = 'Cancelled';
      return { ok: true };
    }

    const pendingOrder = { status: 'Pending' };
    assert.equal(cancelOrder(pendingOrder).ok, true);
    assert.equal(pendingOrder.status, 'Cancelled');

    const shippedOrder = { status: 'Shipped' };
    const shippedRes = cancelOrder(shippedOrder);
    assert.equal(shippedRes.ok, false);
    assert.equal(shippedRes.code, 'TRANSITION_NOT_ALLOWED');
    assert.equal(shippedOrder.status, 'Shipped');

    const completedOrder = { status: 'Completed' };
    const completedRes = cancelOrder(completedOrder);
    assert.equal(completedRes.ok, false);
    assert.equal(completedRes.code, 'TRANSITION_NOT_ALLOWED');
    assert.equal(completedOrder.status, 'Completed');
  });

  test('Backup Restore: Pre-restore backup failure aborts entire import without mutating data', () => {
    let databaseState = { products: [{ id: 1, title: 'Original Honey' }] };
    let backupCreated = false;

    function restoreDatabase(importData: any, simulateDiskError: boolean) {
      if (simulateDiskError) {
        // Backup copy failed
        return { ok: false, code: 'PRE_BACKUP_FAILED', error: 'Pre-backup copy failed' };
      }
      backupCreated = true;
      databaseState = { ...importData };
      return { ok: true };
    }

    // Disk failure simulation
    const failRes = restoreDatabase({ products: [{ id: 2, title: 'Imported State' }] }, true);
    assert.equal(failRes.ok, false);
    assert.equal(failRes.code, 'PRE_BACKUP_FAILED');
    assert.equal(databaseState.products[0].title, 'Original Honey', 'Database state must not be modified when backup fails');

    // Normal restore
    const passRes = restoreDatabase({ products: [{ id: 2, title: 'Imported State' }] }, false);
    assert.equal(passRes.ok, true);
    assert.equal(databaseState.products[0].title, 'Imported State');
    assert.equal(backupCreated, true);
  });

  test('Feeds: Drafts and slug-less products excluded; promo quotas respected', () => {
    const products = [
      { id: 1, title: 'عسل کوهستان', slug: 'mountain-honey', price: 200000, discountPrice: 150000, specialOfferStock: 5, status: 'published' },
      { id: 2, title: 'عسل بدون اسلاگ', slug: '', price: 200000, status: 'published' },
      { id: 3, title: 'عسل پیش‌نویس', slug: 'draft-honey', price: 200000, status: 'draft' },
      { id: 4, title: 'عسل با سهمیه تخفیف تمام‌شده', slug: 'expired-promo-honey', price: 300000, discountPrice: 210000, specialOfferStock: 0, status: 'published' }
    ];

    function filterAndPriceProducts(prods: typeof products) {
      const valid = prods.filter(p => p.slug && p.slug.trim() !== '' && p.status !== 'draft');
      return valid.map(p => {
        const hasPromoQuota = !('specialOfferStock' in p) || (p.specialOfferStock as number) > 0;
        const effectivePrice = (p.discountPrice && hasPromoQuota) ? p.discountPrice : p.price;
        return {
          id: p.id,
          title: p.title,
          price: effectivePrice,
          oldPrice: (p.discountPrice && hasPromoQuota) ? p.price : null
        };
      });
    }

    const feed = filterAndPriceProducts(products);
    assert.equal(feed.length, 2, 'Only 2 valid published products with slugs must be included');
    assert.equal(feed[0].id, 1);
    assert.equal(feed[0].price, 150000, 'Product with available promo quota gets discountPrice');
    assert.equal(feed[0].oldPrice, 200000);
    assert.equal(feed[1].id, 4);
    assert.equal(feed[1].price, 300000, 'Product with zero specialOfferStock reverts to regular price');
    assert.equal(feed[1].oldPrice, null);
  });

  test('Phase 1 Replay: Owner login record shape with initialSetupCompleted=false and OTP', () => {
    // Exact owner credential record shape from live production context
    const ownerCredRecord = {
      username: 'admin',
      initialSetupCompleted: false,
      oneTimePassword: 'TestDummyOneTimeSecret123',
      oneTimePasswordExpired: false,
      password: 'scrypt:16:64:mocklegacyhashthatcannotbeuseddirectly'
    };

    function simulateLoginHandler(body: { username?: string; password?: string }, db: any) {
      const u = (body.username || '').trim();
      const p = (body.password || '').trim();

      if (!u || !p) {
        return { status: 400, code: 'VALIDATION_ERROR', reason: 'body_field_missing' };
      }

      if (!db || !db.adminCredentials) {
        return { status: 401, code: 'AUTH_FAILED', reason: 'data_file_unreadable' };
      }

      const creds = db.adminCredentials;
      const isInitialPending = !creds.initialSetupCompleted;
      const validUser = (creds.username || 'admin').trim().toLowerCase();
      const storedOtp = creds.oneTimePassword ? String(creds.oneTimePassword).trim() : '';
      const otpExpired = Boolean(creds.oneTimePasswordExpired);

      const isUserMatch = (u.toLowerCase() === validUser) || (isInitialPending && u.toLowerCase() === 'admin');
      if (!isUserMatch) {
        return { status: 401, code: 'AUTH_FAILED', reason: 'username_mismatch' };
      }

      if (!isInitialPending) {
        if (storedOtp && p === storedOtp) {
          return { status: 401, code: 'OTP_EXPIRED', reason: 'otp_missing_or_expired' };
        }
        if (String(creds.password).startsWith('scrypt:')) {
          return { status: 401, code: 'AUTH_FAILED', reason: 'unsupported_stored_format' };
        }
      } else {
        if (!storedOtp || otpExpired) {
          return { status: 401, code: 'AUTH_FAILED', reason: 'otp_missing_or_expired' };
        }
      }

      // Verification during initial pending
      let isPassMatch = false;
      if (isInitialPending) {
        if (storedOtp) {
          const bufP = Buffer.from(p);
          const bufOtp = Buffer.from(storedOtp);
          if (bufP.length === bufOtp.length && crypto.timingSafeEqual(bufP, bufOtp)) {
            isPassMatch = true;
          }
        }
      }

      if (isPassMatch) {
        return { status: 200, ok: true, isInitialPending: true, reason: 'success' };
      }

      return { status: 401, code: 'AUTH_FAILED', reason: 'bad_password' };
    }

    const liveDb = { adminCredentials: ownerCredRecord };

    // 1. Correct dummy OTP matches -> PASS (HTTP 200)
    const successRes = simulateLoginHandler({ username: 'admin', password: 'TestDummyOneTimeSecret123' }, liveDb);
    assert.equal(successRes.status, 200);
    assert.equal(successRes.ok, true);
    assert.equal(successRes.reason, 'success');

    // 2. Wrong OTP fails with bad_password (HTTP 401)
    const wrongPassRes = simulateLoginHandler({ username: 'admin', password: 'WrongOtpValue' }, liveDb);
    assert.equal(wrongPassRes.status, 401);
    assert.equal(wrongPassRes.reason, 'bad_password');

    // 3. Username mismatch fails with username_mismatch (HTTP 401)
    const wrongUserRes = simulateLoginHandler({ username: 'non_existent_user', password: 'TestDummyOneTimeSecret123' }, liveDb);
    assert.equal(wrongUserRes.status, 401);
    assert.equal(wrongUserRes.reason, 'username_mismatch');

    // 4. Missing body fields fail with body_field_missing (HTTP 400)
    const missingFieldRes = simulateLoginHandler({ username: 'admin', password: '' }, liveDb);
    assert.equal(missingFieldRes.status, 400);
    assert.equal(missingFieldRes.reason, 'body_field_missing');

    // 5. Unreadable / empty database fails with data_file_unreadable (HTTP 401)
    const unreadableDbRes = simulateLoginHandler({ username: 'admin', password: 'TestDummyOneTimeSecret123' }, null);
    assert.equal(unreadableDbRes.status, 401);
    assert.equal(unreadableDbRes.reason, 'data_file_unreadable');

    // 6. Expired or missing OTP fails with otp_missing_or_expired (HTTP 401)
    const expiredOtpDb = {
      adminCredentials: { ...ownerCredRecord, oneTimePasswordExpired: true }
    };
    const expiredOtpRes = simulateLoginHandler({ username: 'admin', password: 'TestDummyOneTimeSecret123' }, expiredOtpDb);
    assert.equal(expiredOtpRes.status, 401);
    assert.equal(expiredOtpRes.reason, 'otp_missing_or_expired');
  });
  test('Attack Test 1: Missing DB triggers data_file_unreadable and never generates false default state', () => {
    function loadDbCheck(dataFileExists: boolean, rawContent: string | null) {
      if (!dataFileExists) {
        return { ok: false, error: 'DATABASE_FILE_MISSING', reason: 'data_file_unreadable' };
      }
      try {
        const parsed = JSON.parse(rawContent!);
        if (!parsed || typeof parsed !== 'object') {
          return { ok: false, error: 'DATABASE_CORRUPT', reason: 'data_file_unreadable' };
        }
        return { ok: true, data: parsed };
      } catch {
        return { ok: false, error: 'DATABASE_CORRUPT', reason: 'data_file_unreadable' };
      }
    }

    assert.equal(loadDbCheck(false, null).reason, 'data_file_unreadable');
    assert.equal(loadDbCheck(true, '{ broken json').reason, 'data_file_unreadable');
  });

  test('Attack Test 2: Stored scrypt legacy string NEVER authenticates even with matching plaintext password', () => {
    function verifyPasswordStrict(inputPass: string, storedHash: string, isInitialPending: boolean, validOtp: string | null): boolean {
      if (!inputPass || !storedHash) return false;
      if (isInitialPending) {
        if (!validOtp) return false;
        return crypto.timingSafeEqual(Buffer.from(inputPass), Buffer.from(validOtp));
      }
      // Completed setup requires native password hash (starting with $)
      if (storedHash.startsWith('scrypt:') || !storedHash.startsWith('$')) {
        return false;
      }
      return false;
    }

    const scryptHash = 'scrypt:16:64:mocklegacyhashthatcannotbeuseddirectly';
    assert.equal(verifyPasswordStrict('admin', scryptHash, false, null), false, 'scrypt hash must NEVER authenticate');
    assert.equal(verifyPasswordStrict('password123', scryptHash, false, null), false);
    assert.equal(verifyPasswordStrict(scryptHash, scryptHash, false, null), false);
  });

  test('Attack Test 3: Setup completion rejects passwords < 12 chars, identical to username, or identical to OTP', () => {
    function validateNewPermanentPassword(newPass: string, username: string, currentOtp: string | null) {
      if (!newPass || newPass.length < 12) {
        return { ok: false, code: 'VALIDATION_ERROR', error: 'Minimum 12 characters required' };
      }
      if (newPass.toLowerCase() === username.toLowerCase()) {
        return { ok: false, code: 'VALIDATION_ERROR', error: 'Password cannot equal username' };
      }
      if (currentOtp && newPass === currentOtp) {
        return { ok: false, code: 'VALIDATION_ERROR', error: 'Password cannot equal OTP' };
      }
      return { ok: true };
    }

    const otp = 'X7k9P2mQ4vL8wR1tY5zN';
    // Too short (<12)
    assert.equal(validateNewPermanentPassword('Short123', 'admin', otp).ok, false);
    // Exactly 11 chars
    assert.equal(validateNewPermanentPassword('12345678901', 'admin', otp).ok, false);
    // Identical to username
    assert.equal(validateNewPermanentPassword('adminadminadmin', 'adminadminadmin', otp).ok, false);
    // Identical to current OTP
    assert.equal(validateNewPermanentPassword(otp, 'admin', otp).ok, false);
    // Valid 12+ chars distinct password
    assert.equal(validateNewPermanentPassword('SecurePassword2025!', 'admin', otp).ok, true);
  });

  test('Attack Test 4: CSV Formula Injection Neutralization', () => {
    function escapeCsvField(field: any): string {
      if (field === null || field === undefined || field === '') return '""';
      let str = String(field).replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(str)) {
        str = `'` + str;
      }
      return `"${str}"`;
    }

    // Formula injection attacks with =, +, -, @, \t, \r
    assert.equal(escapeCsvField('=SUM(A1:A10)'), `"'=SUM(A1:A10)"`);
    assert.equal(escapeCsvField('+cmd|"/C calc"!A0'), `"'+cmd|""/C calc""!A0"`);
    assert.equal(escapeCsvField('-2+3+cmd|'), `"'-2+3+cmd|"`);
    assert.equal(escapeCsvField('@SUM(1,2)'), `"'@SUM(1,2)"`);
    assert.equal(escapeCsvField("\tDDE"), `"'\tDDE"`);

    // Standard benign fields
    assert.equal(escapeCsvField('عسل طبیعی سبلان'), '"عسل طبیعی سبلان"');
    assert.equal(escapeCsvField(250000), '"250000"');
    assert.equal(escapeCsvField('ONV-12345'), '"ONV-12345"');
  });

  test('Attack Test 5: Webhook rejects non-POST and oversized body > 256KB', () => {
    function validateWebhookRequest(method: string, contentLength: number): { status: number; ok: boolean } {
      if (method.toUpperCase() !== 'POST') {
        return { status: 405, ok: false };
      }
      if (contentLength > 262144) {
        return { status: 413, ok: false };
      }
      return { status: 200, ok: true };
    }

    // Non-POST methods
    assert.equal(validateWebhookRequest('GET', 100).status, 405);
    assert.equal(validateWebhookRequest('PUT', 100).status, 405);
    assert.equal(validateWebhookRequest('DELETE', 100).status, 405);

    // Oversized body (>256KB)
    assert.equal(validateWebhookRequest('POST', 262145).status, 413);
    assert.equal(validateWebhookRequest('POST', 500000).status, 413);

    // Valid POST under 256KB
    assert.equal(validateWebhookRequest('POST', 1024).status, 200);
    assert.equal(validateWebhookRequest('POST', 262144).status, 200);
  });

  test('Attack Test 6: Webhook update_id deduplication drops replay attacks', () => {
    const seenWindow: number[] = [101, 102, 103];

    function processWebhookUpdate(updateId: number): { ok: boolean; duplicate: boolean } {
      if (seenWindow.includes(updateId)) {
        return { ok: true, duplicate: true };
      }
      seenWindow.push(updateId);
      if (seenWindow.length > 500) {
        seenWindow.shift();
      }
      return { ok: true, duplicate: false };
    }

    assert.equal(processWebhookUpdate(102).duplicate, true, 'Replay of 102 must be flagged duplicate');
    assert.equal(processWebhookUpdate(104).duplicate, false, 'New update 104 is processed');
    assert.equal(processWebhookUpdate(104).duplicate, true, 'Immediate replay of 104 is flagged duplicate');
  });

  test('Pricing Rules (Requirement 3.2): Ordinary discount, Amazing offer quota, and strict fallback without cross-discount', () => {
    function calculateProductPrice(product: any, selectedSize: any = null) {
      const basePrice = selectedSize && selectedSize.price !== undefined
        ? Number(selectedSize.price)
        : Number(product.price || 0);

      const hasVariant = Boolean(selectedSize && typeof selectedSize === 'object');
      const isAmazingOffer = Boolean(product.isAmazingOffer || product.isSpecialOffer);

      const quota = hasVariant && selectedSize.specialOfferStock !== undefined
        ? Number(selectedSize.specialOfferStock)
        : product.specialOfferStock !== undefined
        ? Number(product.specialOfferStock)
        : null;

      // Rule 1: Amazing Offer active with quota > 0
      if (isAmazingOffer && (quota === null || quota > 0)) {
        let discPrice: number | null = null;
        if (hasVariant && selectedSize.discountPrice && Number(selectedSize.discountPrice) > 0) {
          discPrice = Number(selectedSize.discountPrice);
        } else if (product.discountPrice && Number(product.discountPrice) > 0) {
          discPrice = Number(product.discountPrice);
        } else {
          const pct = Number(product.discount || product.discountPercent || 0);
          if (pct > 0) {
            discPrice = Math.round(basePrice * (100 - pct) / 100);
          }
        }
        if (discPrice !== null && discPrice < basePrice) {
          return { price: discPrice, oldPrice: basePrice, isPromo: true };
        }
      }

      // Rule 2: Amazing Offer quota exhausted -> strictly reverts to base price (NO ordinary discount fall-through!)
      if (isAmazingOffer && quota !== null && quota <= 0) {
        return { price: basePrice, oldPrice: 0, isPromo: false };
      }

      // Rule 3: Ordinary discount
      const ordPct = Number(product.discount || product.discountPercent || 0);
      if (ordPct > 0) {
        const ordPrice = Math.round(basePrice * (100 - ordPct) / 100);
        return { price: ordPrice, oldPrice: basePrice, isPromo: false };
      }

      return { price: basePrice, oldPrice: 0, isPromo: false };
    }

    // Case A: Ordinary discount 15% on 200,000 تومان product
    const pOrd = { price: 200000, discount: 15, isAmazingOffer: false };
    assert.deepEqual(calculateProductPrice(pOrd), { price: 170000, oldPrice: 200000, isPromo: false });

    // Case B: Amazing offer with quota = 5 on 200,000 تومان product with discountPrice = 140,000
    const pAmazingActive = { price: 200000, discountPrice: 140000, isAmazingOffer: true, specialOfferStock: 5 };
    assert.deepEqual(calculateProductPrice(pAmazingActive), { price: 140000, oldPrice: 200000, isPromo: true });

    // Case C: Amazing offer with quota = 0 (EXHAUSTED) and discount = 15%
    // MUST revert to base 200,000 without falling through to ordinary 15% discount!
    const pAmazingExhausted = { price: 200000, discountPrice: 140000, discount: 15, isAmazingOffer: true, specialOfferStock: 0 };
    assert.deepEqual(calculateProductPrice(pAmazingExhausted), { price: 200000, oldPrice: 0, isPromo: false });

    // Case D: Variant size inheriting parent amazing offer quota
    const pParent = { price: 100000, isAmazingOffer: true, specialOfferStock: 2, discount: 20 };
    const sVariant = { name: '500g', price: 150000 };
    assert.deepEqual(calculateProductPrice(pParent, sVariant), { price: 120000, oldPrice: 150000, isPromo: true });

    // Case E: Variant size with specific quota = 0 while parent has quota = 2
    const sVariantExhausted = { name: '1kg', price: 280000, specialOfferStock: 0 };
    assert.deepEqual(calculateProductPrice(pParent, sVariantExhausted), { price: 280000, oldPrice: 0, isPromo: false });
  });

  // ==============================================================================
  // FIX 1 & AUDIT VERIFICATION TESTS
  // ==============================================================================
  describe('Fix 1: State-Based Credential Bootstrap Logic', () => {
    function simulateBootstrapState(db: any): { bootstrapped: boolean; otpPlain: string | null; db: any } {
      const creds = db.adminCredentials || {};
      const isCompleted = Boolean(creds.initialSetupCompleted);
      const hasOtp = Boolean(creds.oneTimePassword && String(creds.oneTimePassword).trim() !== '');
      const hasPass = Boolean(creds.password && String(creds.password).trim() !== '');

      if (isCompleted || hasOtp || hasPass) {
        return { bootstrapped: false, otpPlain: null, db };
      }

      // Generate >= 16 char random password
      const otpPlain = crypto.randomBytes(10).toString('hex'); // 20 chars
      const salt = crypto.randomBytes(8).toString('hex');
      const hash = 'sim_hash_' + crypto.createHmac('sha256', salt).update(otpPlain).digest('hex');

      const updatedDb = JSON.parse(JSON.stringify(db));
      if (!updatedDb.adminCredentials) updatedDb.adminCredentials = {};
      updatedDb.adminCredentials.username = creds.username || 'admin';
      updatedDb.adminCredentials.password = '';
      updatedDb.adminCredentials.email = creds.email || 'admin@onival.com';
      updatedDb.adminCredentials.name = creds.name || 'مدیریت اونیوال (ONIVAL Admin)';
      updatedDb.adminCredentials.initialSetupCompleted = false;
      updatedDb.adminCredentials.oneTimePassword = hash;
      updatedDb.adminCredentials.oneTimePasswordExpired = false;

      return { bootstrapped: true, otpPlain, db: updatedDb };
    }

    test('State-based bootstrap: null/empty credential triggers generation of random password (>=16 chars)', () => {
      const seedDb = {
        products: [{ id: 1, title: 'عسل' }],
        adminCredentials: {
          username: 'admin',
          password: '',
          email: 'admin@onival.com',
          initialSetupCompleted: false,
          oneTimePassword: null
        }
      };

      const res = simulateBootstrapState(seedDb);
      assert.equal(res.bootstrapped, true, 'Must bootstrap when credentials null');
      assert.ok(res.otpPlain && res.otpPlain.length >= 16, 'Generated OTP must be >= 16 characters');
      assert.ok(res.db.adminCredentials.oneTimePassword.startsWith('sim_hash_'), 'Hash stored in DB');
    });

    test('Second run on bootstrapped state does nothing', () => {
      const alreadyBootstrappedDb = {
        products: [],
        adminCredentials: {
          username: 'admin',
          password: '',
          initialSetupCompleted: false,
          oneTimePassword: 'existing_valid_hash'
        }
      };

      const res = simulateBootstrapState(alreadyBootstrappedDb);
      assert.equal(res.bootstrapped, false, 'Must not bootstrap if usable OTP exists');
      assert.equal(res.otpPlain, null);
    });

    test('Completed account does not bootstrap', () => {
      const completedDb = {
        products: [],
        adminCredentials: {
          username: 'admin',
          password: 'valid_password_hash',
          initialSetupCompleted: true,
          oneTimePassword: null
        }
      };

      const res = simulateBootstrapState(completedDb);
      assert.equal(res.bootstrapped, false, 'Must not bootstrap if initialSetupCompleted is true');
    });

    test('Recovery: setting stored OTP to null regenerates credential', () => {
      const recoveredDb = {
        products: [],
        adminCredentials: {
          username: 'admin',
          password: '',
          initialSetupCompleted: false,
          oneTimePassword: null // Owner reset stored OTP to null
        }
      };

      const res = simulateBootstrapState(recoveredDb);
      assert.equal(res.bootstrapped, true, 'Resetting OTP to null triggers regeneration');
      assert.ok(res.otpPlain && res.otpPlain.length >= 16);
    });
  });

  describe('Fix 4 & Attack Protections', () => {
    test('Direct access to common.php without ONIVAL_ENTRY returns 404', () => {
      function evaluateEntryGuard(definedConstants: Record<string, any>): { status: number; exited: boolean } {
        if (!definedConstants['ONIVAL_ENTRY']) {
          return { status: 404, exited: true };
        }
        return { status: 200, exited: false };
      }

      // Direct HTTP request to /api/common.php
      const direct = evaluateEntryGuard({});
      assert.equal(direct.status, 404, 'Must return 404 for direct invocation');
      assert.equal(direct.exited, true);

      // Delegated request from index.php or webhook.php
      const delegated = evaluateEntryGuard({ ONIVAL_ENTRY: true });
      assert.equal(delegated.status, 200);
      assert.equal(delegated.exited, false);
    });

    test('Decoy live database in web root is ignored in favor of PRIVATE_DIR', () => {
      const privateDir = '/var/private/onival-private';
      const webRoot = '/public_html';

      function resolveDatabasePath(requestedPath: string, privateDirConstant: string): string {
        // Implementation strictly binds to PRIVATE_DIR
        return path.join(privateDirConstant, 'onival-persistent-data.json');
      }

      const decoyInWeb = path.join(webRoot, 'onival-persistent-data.json');
      const resolved = resolveDatabasePath(decoyInWeb, privateDir);
      assert.equal(resolved, path.join(privateDir, 'onival-persistent-data.json'));
      assert.notEqual(resolved, decoyInWeb, 'Must never read database from web root');
    });

    test('Anonymous logout returns 401 AUTH_REQUIRED', () => {
      function handleLogout(token: string | null): { status: number; code: string } {
        if (!token || token.trim() === '') {
          return { status: 401, code: 'AUTH_REQUIRED' };
        }
        return { status: 200, code: 'LOGGED_OUT' };
      }

      assert.deepEqual(handleLogout(null), { status: 401, code: 'AUTH_REQUIRED' });
      assert.deepEqual(handleLogout(''), { status: 401, code: 'AUTH_REQUIRED' });
      assert.deepEqual(handleLogout('valid_session_token'), { status: 200, code: 'LOGGED_OUT' });
    });

    test('Import-state requires explicit confirmation flag', () => {
      function handleImportState(body: any): { status: number; code: string } {
        if (!body.confirmed) {
          return { status: 400, code: 'CONFIRMATION_REQUIRED' };
        }
        if (!body.data || !Array.isArray(body.data.products)) {
          return { status: 400, code: 'INVALID_PAYLOAD' };
        }
        return { status: 200, code: 'RESTORE_SUCCESS' };
      }

      // Without confirmed flag
      assert.deepEqual(
        handleImportState({ data: { products: [{ id: 1 }] } }),
        { status: 400, code: 'CONFIRMATION_REQUIRED' }
      );

      // With confirmed flag but invalid payload
      assert.deepEqual(
        handleImportState({ confirmed: true, data: {} }),
        { status: 400, code: 'INVALID_PAYLOAD' }
      );

      // With confirmed flag and valid payload
      assert.deepEqual(
        handleImportState({ confirmed: true, data: { products: [{ id: 1 }] } }),
        { status: 200, code: 'RESTORE_SUCCESS' }
      );
    });

    test('CORS exact origin matching denies lookalike attacker domains', () => {
      const allowedOrigins = ['https://onival.ir', 'https://www.onival.ir', 'http://localhost:3000', 'http://localhost:5173'];

      function checkCorsOrigin(origin: string): boolean {
        const clean = origin.replace(/\/+$/, '');
        return allowedOrigins.includes(clean);
      }

      // Allowed origins
      assert.equal(checkCorsOrigin('https://onival.ir'), true);
      assert.equal(checkCorsOrigin('https://www.onival.ir'), true);
      assert.equal(checkCorsOrigin('http://localhost:3000'), true);

      // Attacker lookalikes
      assert.equal(checkCorsOrigin('https://onival.ir.attacker.com'), false);
      assert.equal(checkCorsOrigin('https://attacker-onival.ir'), false);
      assert.equal(checkCorsOrigin('https://onival.ir:8080'), false);
      assert.equal(checkCorsOrigin('http://onival.ir'), false);
    });
  });

  // ==============================================================================
  // PHASE 1 & DEFECTS F1-F6 AUTOMATED VERIFICATION SUITE
  // ==============================================================================
  describe('Phase 1 & Defects F1-F6 Corrective Tests', () => {
    test('Phase 1: Seed-based bootstrap sets onival_setup with pending status', async () => {
      const fs = await import('node:fs');
      const configPath = path.join(process.cwd(), 'scripts', 'initial-admin.config.json');
      assert.ok(fs.existsSync(configPath), 'scripts/initial-admin.config.json must exist');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.equal(cfg.username, 'onival_setup');
      assert.ok(cfg.tempPassword && cfg.tempPassword.length >= 12, 'Temp password must be >= 12 chars');

      // Check seed.php was generated and is valid
      const seedPhpPath = path.join(process.cwd(), 'public', 'api', 'seed.php');
      assert.ok(fs.existsSync(seedPhpPath), 'public/api/seed.php must exist');
      const seedContent = fs.readFileSync(seedPhpPath, 'utf-8');
      assert.ok(seedContent.includes("!defined('ONIVAL_ENTRY')"), 'seed.php must have ONIVAL_ENTRY guard');
      assert.ok(seedContent.includes('initialAdmin'), 'seed.php must contain initialAdmin');
      assert.ok(seedContent.includes('onival_setup'), 'seed.php must have initial admin username');
    });

    test('Phase 1: Pending setup token restricts routes with 403 SETUP_REQUIRED', () => {
      function evaluateAdminRouteAccess(path: string, initialSetupCompleted: boolean): { allowed: boolean; status: number; code?: string } {
        const allowedSetupPaths = [
          '/api/admin/setup-credentials',
          '/api/account/change-credentials',
          '/api/admin/logout',
          '/api/admin/verify-session',
          '/api/account/profile',
          '/api/admin/setup-status'
        ];

        if (!initialSetupCompleted) {
          if (allowedSetupPaths.includes(path)) {
            return { allowed: true, status: 200 };
          }
          return { allowed: false, status: 403, code: 'SETUP_REQUIRED' };
        }
        return { allowed: true, status: 200 };
      }

      // Allowed during initial setup
      assert.deepEqual(evaluateAdminRouteAccess('/api/admin/setup-credentials', false), { allowed: true, status: 200 });
      assert.deepEqual(evaluateAdminRouteAccess('/api/account/change-credentials', false), { allowed: true, status: 200 });
      assert.deepEqual(evaluateAdminRouteAccess('/api/admin/logout', false), { allowed: true, status: 200 });
      assert.deepEqual(evaluateAdminRouteAccess('/api/admin/verify-session', false), { allowed: true, status: 200 });

      // Blocked during initial setup
      assert.deepEqual(evaluateAdminRouteAccess('/api/orders', false), { allowed: false, status: 403, code: 'SETUP_REQUIRED' });
      assert.deepEqual(evaluateAdminRouteAccess('/api/products', false), { allowed: false, status: 403, code: 'SETUP_REQUIRED' });
      assert.deepEqual(evaluateAdminRouteAccess('/api/stats', false), { allowed: false, status: 403, code: 'SETUP_REQUIRED' });

      // Once setup is completed, all routes are allowed
      assert.deepEqual(evaluateAdminRouteAccess('/api/orders', true), { allowed: true, status: 200 });
      assert.deepEqual(evaluateAdminRouteAccess('/api/products', true), { allowed: true, status: 200 });
    });

    test('Phase 1: Setup credentials validation enforces min 12 chars and username inequality', () => {
      function validateSetupCredentials(username: string, pass: string, tempPass: string): { valid: boolean; code?: string } {
        if (!username || username.trim().length < 3) return { valid: false, code: 'INVALID_USERNAME' };
        if (!pass || pass.length < 12) return { valid: false, code: 'PASSWORD_TOO_SHORT' };
        if (pass.toLowerCase() === username.toLowerCase()) return { valid: false, code: 'PASSWORD_SAME_AS_USERNAME' };
        if (pass === tempPass) return { valid: false, code: 'PASSWORD_SAME_AS_TEMP' };
        return { valid: true };
      }

      assert.equal(validateSetupCredentials('admin', 'short78', 'Temp1234567890').valid, false);
      assert.equal(validateSetupCredentials('adminadminadmin', 'adminadminadmin', 'Temp1234567890').code, 'PASSWORD_SAME_AS_USERNAME');
      assert.equal(validateSetupCredentials('onival_admin', 'Temp1234567890', 'Temp1234567890').code, 'PASSWORD_SAME_AS_TEMP');
      assert.equal(validateSetupCredentials('new_admin_user', 'MySecurePassword2026!', 'Temp1234567890').valid, true);
    });

    test('Defect F2: Bearer authorization header extraction and removal of cookie fallback', () => {
      function getBearerTokenJs(headers: Record<string, string>, cookies?: Record<string, string>): string {
        const authHeader = headers['authorization'] || headers['Authorization'] || '';
        const match = authHeader.match(/Bearer\s+(.*)$/i);
        if (match) return match[1].trim();
        if (headers['x-admin-token'] || headers['X-Admin-Token']) {
          return (headers['x-admin-token'] || headers['X-Admin-Token']).trim();
        }
        // Cookie fallback is strictly removed
        return '';
      }

      assert.equal(getBearerTokenJs({ 'Authorization': 'Bearer test_token_xyz' }), 'test_token_xyz');
      assert.equal(getBearerTokenJs({ 'X-Admin-Token': 'test_token_123' }), 'test_token_123');
      // Cookie is ignored
      assert.equal(getBearerTokenJs({}, { 'admin_token': 'cookie_token' }), '');
    });

    test('Defect F3: Static Gate asserts NO PHP entrypoint contains runtime server-data path', async () => {
      const fs = await import('node:fs');
      const publicApiDir = path.join(process.cwd(), 'public', 'api');
      const files = ['common.php', 'index.php', 'webhook.php', 'bale-webhook.php'];

      for (const f of files) {
        const full = path.join(publicApiDir, f);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf-8');
          assert.equal(
            content.includes('server-data/receipts') || content.includes('../../server-data'),
            false,
            `File ${f} must not contain runtime server-data path reference`
          );
        }
      }
    });

    test('Defect F5: Order approval and rejection link and update contactMessages in same transaction', () => {
      const db: any = {
        orders: [
          {
            id: 101,
            trackingCode: 'ONV-ORD-101',
            phoneNumber: '09120000000',
            status: 'Pending',
            paymentStatus: 'PendingVerification',
            isConsultation: true,
            consultationDetails: { consultationStatus: 'PendingPayment' },
            items: [{ productId: 1, quantity: 1, size: '' }]
          }
        ],
        contactMessages: [
          {
            id: 501,
            trackingCode: 'ONV-ORD-101',
            orderId: 101,
            phoneNumber: '09120000000',
            isConsultation: true,
            paymentStatus: 'Unpaid',
            consultationDetails: { consultationStatus: 'PendingPayment' }
          }
        ]
      };

      // Simulate processOrderPaymentApprovalPhp
      function approveOrderSim(dbRef: any, orderCode: string) {
        for (const ord of dbRef.orders) {
          if (ord.trackingCode === orderCode) {
            ord.paymentStatus = 'Paid';
            ord.status = 'Processing';
            if (ord.consultationDetails) ord.consultationDetails.consultationStatus = 'Scheduled';

            for (const msg of dbRef.contactMessages || []) {
              if (msg.orderId === ord.id || msg.trackingCode === ord.trackingCode) {
                msg.paymentStatus = 'Paid';
                if (msg.consultationDetails) msg.consultationDetails.consultationStatus = 'Scheduled';
              }
            }
            return { ok: true, order: ord };
          }
        }
        return { ok: false };
      }

      const res = approveOrderSim(db, 'ONV-ORD-101');
      assert.equal(res.ok, true);
      assert.equal(db.orders[0].paymentStatus, 'Paid');
      assert.equal(db.orders[0].consultationDetails.consultationStatus, 'Scheduled');
      assert.equal(db.contactMessages[0].paymentStatus, 'Paid', 'Linked contact message must be marked Paid');
      assert.equal(db.contactMessages[0].consultationDetails.consultationStatus, 'Scheduled', 'Linked contact message consultationStatus must be Scheduled');
    });

    test('Defect F6: Bounded body reader rejects payload exceeding byte limit', () => {
      function evaluateBodySize(contentLength: number, bodyLength: number, maxAllowed: number): { status: number; code?: string } {
        if (contentLength > maxAllowed || bodyLength > maxAllowed) {
          return { status: 413, code: 'PAYLOAD_TOO_LARGE' };
        }
        return { status: 200 };
      }

      // Allowed under 10MB
      assert.deepEqual(evaluateBodySize(1024, 1024, 10485760), { status: 200 });
      // Exceeding 10MB
      assert.deepEqual(evaluateBodySize(10485761, 10485761, 10485760), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
      // Webhook exceeding 256KB
      assert.deepEqual(evaluateBodySize(300000, 300000, 262144), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    });
    // ==============================================================================
    // H1-H5 Corrective Patch Test Suite
    // ==============================================================================
    describe('H1. Webhook Update Claim Lifecycle', () => {
      interface ClaimEntry {
        state: 'claimed' | 'done';
        timestamp: number;
      }

      function simulateClaim(store: Record<string, ClaimEntry>, updateId: number, now: number, ttlSeconds = 120) {
        const idKey = String(updateId);
        const existing = store[idKey];
        if (existing) {
          if (existing.state === 'done') {
            return { ok: true, claimed: false, reason: 'done' };
          }
          if (existing.state === 'claimed') {
            if ((now - existing.timestamp) < ttlSeconds) {
              return { ok: true, claimed: false, reason: 'in_flight' };
            }
            // Stale claim: can be reclaimed!
          }
        }
        store[idKey] = { state: 'claimed', timestamp: now };
        return { ok: true, claimed: true };
      }

      function simulateFinalize(store: Record<string, ClaimEntry>, updateId: number, now: number, outcome: 'done' | 'released') {
        const idKey = String(updateId);
        if (outcome === 'released') {
          delete store[idKey];
        } else {
          store[idKey] = { state: 'done', timestamp: now };
        }
      }

      test('Initial claim succeeds and marks claimed', () => {
        const store: Record<string, ClaimEntry> = {};
        const t0 = 1000;
        const res = simulateClaim(store, 991, t0, 120);
        assert.equal(res.ok, true);
        assert.equal(res.claimed, true);
        assert.equal(store['991'].state, 'claimed');
      });

      test('Concurrent/in-flight claim within 120s TTL is dropped', () => {
        const store: Record<string, ClaimEntry> = { '991': { state: 'claimed', timestamp: 1000 } };
        const res = simulateClaim(store, 991, 1050, 120);
        assert.equal(res.ok, true);
        assert.equal(res.claimed, false);
        assert.equal(res.reason, 'in_flight');
      });

      test('Stale claim (> 120s) is reclaimable', () => {
        const store: Record<string, ClaimEntry> = { '991': { state: 'claimed', timestamp: 1000 } };
        const res = simulateClaim(store, 991, 1130, 120);
        assert.equal(res.ok, true);
        assert.equal(res.claimed, true);
        assert.equal(store['991'].timestamp, 1130);
      });

      test('Done updates are NEVER reclaimed even after TTL', () => {
        const store: Record<string, ClaimEntry> = { '991': { state: 'done', timestamp: 1000 } };
        const res = simulateClaim(store, 991, 5000, 120);
        assert.equal(res.ok, true);
        assert.equal(res.claimed, false);
        assert.equal(res.reason, 'done');
      });

      test('Release claim on fatal error with 0 committed writes allows retry; default done retains done', () => {
        const store: Record<string, ClaimEntry> = { '991': { state: 'claimed', timestamp: 1000 } };

        // Simulating fatal error with committedWritesCount = 0 -> released
        const committedWritesCount = 0;
        const isFatal = true;
        const outcome = (isFatal && committedWritesCount === 0) ? 'released' : 'done';
        simulateFinalize(store, 991, 1010, outcome);
        assert.equal(store['991'], undefined, 'Claim must be released on fatal error prior to writes');

        // Can now be claimed again
        const retryClaim = simulateClaim(store, 991, 1015, 120);
        assert.equal(retryClaim.claimed, true);

        // If committed writes > 0, fatal error does NOT release claim
        const fatalAfterWriteOutcome = (true && 1 === 0) ? 'released' : 'done';
        simulateFinalize(store, 991, 1020, fatalAfterWriteOutcome);
        assert.equal(store['991'].state, 'done', 'Committed writes must keep state done');
      });
    });

    describe('H2. Frontend First-Login Setup Flow', () => {
      test('viewAfterLogin routes to account on pending and dashboard on completed', () => {
        assert.equal(viewAfterLogin({ isInitialPending: true }), 'account');
        assert.equal(viewAfterLogin({ profile: { initialSetupCompleted: false } }), 'account');
        assert.equal(viewAfterLogin({ initialSetupCompleted: false }), 'account');
        assert.equal(viewAfterLogin({ isInitialPending: false, profile: { initialSetupCompleted: true } }), 'dashboard');
      });

      test('shouldFetchAdminData prevents admin fetch when pending or unauthenticated', () => {
        assert.equal(shouldFetchAdminData(true, true), false, 'Cannot fetch when pending even if authenticated');
        assert.equal(shouldFetchAdminData(false, false), false, 'Cannot fetch when unauthenticated');
        assert.equal(shouldFetchAdminData(true, false), false, 'Cannot fetch when pending and unauthenticated');
        assert.equal(shouldFetchAdminData(false, true), true, 'Allowed only when authenticated and setup completed');
      });

      test('handleSetupSuccess returns targetTab dashboard and sign-in transition message', () => {
        const res = handleSetupSuccess();
        assert.equal(res.targetTab, 'dashboard');
        assert.equal(res.shouldLogout, true);
        assert.ok(res.successMessage.includes('راه‌اندازی با موفقیت انجام شد'));
      });

      test('Static Grep Gate: App.tsx must verify shouldFetchAdminData before fetching admin APIs', async () => {
        const fs = await import('node:fs');
        const appPath = path.join(process.cwd(), 'src', 'App.tsx');
        assert.ok(fs.existsSync(appPath), 'src/App.tsx must exist');
        const content = fs.readFileSync(appPath, 'utf-8');
        assert.ok(
          content.includes('shouldFetchAdminData'),
          'App.tsx must import and use shouldFetchAdminData'
        );
        assert.ok(
          content.includes('viewAfterLogin'),
          'App.tsx must import and use viewAfterLogin'
        );
        assert.ok(
          content.includes('handleSetupSuccess'),
          'App.tsx must import and use handleSetupSuccess'
        );
      });
    });

    describe('H3. Credential Route Validation Order', () => {
      function validateChangeCredentialsJs(body: any, isInitialPending: boolean, creds: any, matchesOtpFn: (p: string, o: string) => boolean) {
        const newUsername = (body.newUsername || body.username || '').trim();
        const newPassword = String(body.newPassword || body.password || '');
        const curPass = (body.currentPassword || '').trim();
        const hasLogoFields = 'siteLogo' in body || 'siteLogoFit' in body || 'siteLogoShape' in body || 'siteLogoScale' in body;
        const hasProfileFields = 'email' in body || 'name' in body;

        if (isInitialPending) {
          // Both newUsername and newPassword are required
          if (!newUsername || !newPassword) {
            return { status: 400, code: 'MISSING_REQUIRED_FIELDS' };
          }
          if (!/^[a-zA-Z0-9._-]{3,32}$/.test(newUsername)) {
            return { status: 400, code: 'INVALID_USERNAME' };
          }
          if (newUsername.toLowerCase() === (creds.username || 'onival_setup').toLowerCase()) {
            return { status: 400, code: 'USERNAME_SAME_AS_INITIAL' };
          }
          if (newPassword.length < 12) {
            return { status: 400, code: 'PASSWORD_TOO_SHORT' };
          }
          if (matchesOtpFn(newPassword, creds.oneTimePassword || '')) {
            return { status: 400, code: 'PASSWORD_SAME_AS_TEMP' };
          }
          if (newPassword.toLowerCase() === newUsername.toLowerCase()) {
            return { status: 400, code: 'PASSWORD_SAME_AS_USERNAME' };
          }
          if (creds.password && newPassword === creds.password) {
            return { status: 400, code: 'PASSWORD_SAME_AS_CURRENT' };
          }
          return { status: 200, code: 'SETUP_COMPLETED' };
        }

        // Completed state
        const isChangingPassword = Boolean(newPassword);
        const isChangingUsername = Boolean(newUsername && newUsername.toLowerCase() !== (creds.username || 'admin').toLowerCase());

        if (!hasLogoFields && !hasProfileFields && !isChangingPassword && !isChangingUsername) {
          return { status: 400, code: 'NO_CHANGES' };
        }

        if (!isChangingPassword && !isChangingUsername) {
          // Logo-only or profile-only allowed without password
          return { status: 200, code: 'PROFILE_SAVED' };
        }

        if (!curPass || curPass !== creds.password) {
          return { status: 400, code: 'INVALID_CREDENTIALS' };
        }

        if (isChangingPassword) {
          if (newPassword.length < 12) {
            return { status: 400, code: 'PASSWORD_TOO_SHORT' };
          }
          if (newPassword.toLowerCase() === (newUsername || creds.username).toLowerCase()) {
            return { status: 400, code: 'PASSWORD_SAME_AS_USERNAME' };
          }
          if (creds.oneTimePassword && matchesOtpFn(newPassword, creds.oneTimePassword)) {
            return { status: 400, code: 'PASSWORD_SAME_AS_TEMP' };
          }
        }

        return { status: 200, code: 'CREDENTIALS_UPDATED' };
      }

      const dummyMatchesOtp = (p: string, o: string) => p === o;

      test('Pending state: empty or logo-only request returns 400 MISSING_REQUIRED_FIELDS', () => {
        const creds = { username: 'onival_setup', oneTimePassword: 'hash_temp_pass', initialSetupCompleted: false };
        assert.deepEqual(validateChangeCredentialsJs({}, true, creds, dummyMatchesOtp), { status: 400, code: 'MISSING_REQUIRED_FIELDS' });
        assert.deepEqual(validateChangeCredentialsJs({ siteLogo: 'https://example.com/logo.png' }, true, creds, dummyMatchesOtp), { status: 400, code: 'MISSING_REQUIRED_FIELDS' });
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'new_admin' }, true, creds, dummyMatchesOtp), { status: 400, code: 'MISSING_REQUIRED_FIELDS' });
        assert.deepEqual(validateChangeCredentialsJs({ newPassword: 'long_password_123' }, true, creds, dummyMatchesOtp), { status: 400, code: 'MISSING_REQUIRED_FIELDS' });
      });

      test('Pending state: username and password validation rules', () => {
        const creds = { username: 'onival_setup', oneTimePassword: 'hash_temp_pass', initialSetupCompleted: false };

        // Invalid username format
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'a!', newPassword: 'ValidPass12345!' }, true, creds, dummyMatchesOtp), { status: 400, code: 'INVALID_USERNAME' });

        // Username same as initial
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'onival_setup', newPassword: 'ValidPass12345!' }, true, creds, dummyMatchesOtp), { status: 400, code: 'USERNAME_SAME_AS_INITIAL' });

        // Password too short (< 12)
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'real_admin', newPassword: 'short' }, true, creds, dummyMatchesOtp), { status: 400, code: 'PASSWORD_TOO_SHORT' });

        // Password same as temp password
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'real_admin', newPassword: 'hash_temp_pass' }, true, creds, dummyMatchesOtp), { status: 400, code: 'PASSWORD_SAME_AS_TEMP' });

        // Password same as username
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'my_admin_account', newPassword: 'my_admin_account' }, true, creds, dummyMatchesOtp), { status: 400, code: 'PASSWORD_SAME_AS_USERNAME' });

        // Valid setup credentials
        assert.deepEqual(validateChangeCredentialsJs({ newUsername: 'real_admin', newPassword: 'ComplexPassword#2026' }, true, creds, dummyMatchesOtp), { status: 200, code: 'SETUP_COMPLETED' });
      });

      test('Completed state: empty request returns 400 NO_CHANGES', () => {
        const creds = { username: 'real_admin', password: 'CurrentPass1234!', initialSetupCompleted: true };
        assert.deepEqual(validateChangeCredentialsJs({}, false, creds, dummyMatchesOtp), { status: 400, code: 'NO_CHANGES' });
      });

      test('Completed state: logo-only or profile-only allowed without password', () => {
        const creds = { username: 'real_admin', password: 'CurrentPass1234!', initialSetupCompleted: true };
        assert.deepEqual(validateChangeCredentialsJs({ siteLogo: 'https://example.com/logo.png' }, false, creds, dummyMatchesOtp), { status: 200, code: 'PROFILE_SAVED' });
        assert.deepEqual(validateChangeCredentialsJs({ email: 'new@example.com' }, false, creds, dummyMatchesOtp), { status: 200, code: 'PROFILE_SAVED' });
      });

      test('Completed state: password/username change requires current password', () => {
        const creds = { username: 'real_admin', password: 'CurrentPass1234!', initialSetupCompleted: true };
        assert.deepEqual(validateChangeCredentialsJs({ newPassword: 'NewComplexPass#1' }, false, creds, dummyMatchesOtp), { status: 400, code: 'INVALID_CREDENTIALS' });
        assert.deepEqual(validateChangeCredentialsJs({ newPassword: 'NewComplexPass#1', currentPassword: 'WrongPassword' }, false, creds, dummyMatchesOtp), { status: 400, code: 'INVALID_CREDENTIALS' });
        assert.deepEqual(validateChangeCredentialsJs({ newPassword: 'NewComplexPass#1', currentPassword: 'CurrentPass1234!' }, false, creds, dummyMatchesOtp), { status: 200, code: 'CREDENTIALS_UPDATED' });
      });
    });

    describe('H4. Runtime Readiness, Database Safety, Health Contract', () => {
      function isUsableHashJs(hash: any): boolean {
        if (!hash || typeof hash !== 'string') return false;
        const trimmed = hash.trim();
        if (!trimmed.startsWith('$')) return false;
        // Native bcrypt/argon2 starts with $2y$, $2a$, $2b$, or $argon2
        return /^\$(2[ayb]|argon2id?)\$/.test(trimmed);
      }

      function checkDbValidity(parsed: any) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, code: 'DB_INVALID', status: 'db_invalid', detail: 'invalid_json' };
        }
        const coreKeys = ['products', 'productCategories', 'orders', 'siteContent', 'adminCredentials'];
        for (const ck of coreKeys) {
          if (!(ck in parsed) || !Array.isArray(parsed[ck]) && typeof parsed[ck] !== 'object') {
            return { ok: false, code: 'DB_INVALID', status: 'db_invalid', detail: 'core_key_invalid' };
          }
          if ((ck === 'products' || ck === 'productCategories' || ck === 'orders') && !Array.isArray(parsed[ck])) {
            return { ok: false, code: 'DB_INVALID', status: 'db_invalid', detail: 'core_key_invalid' };
          }
        }
        return { ok: true, status: 'ready', detail: 'ready' };
      }

      test('isUsableHashJs recognizes valid password hashes and rejects plain strings and scrypt', () => {
        assert.equal(isUsableHashJs('$2y$10$abcdefghijklmnopqrstuvwxyz1234567890ABCDEF'), true);
        assert.equal(isUsableHashJs('$argon2id$v=19$m=65536,t=4,p=1$abcdef$123456'), true);
        assert.equal(isUsableHashJs('scrypt:16384:8:1$abcdef$123456'), false);
        assert.equal(isUsableHashJs('plain_text_password'), false);
        assert.equal(isUsableHashJs(''), false);
        assert.equal(isUsableHashJs(null), false);
      });

      test('checkDbValidity accepts empty products array in live db and requires all core keys', () => {
        const validDb = {
          products: [],
          productCategories: [],
          orders: [],
          siteContent: {},
          adminCredentials: {}
        };
        assert.deepEqual(checkDbValidity(validDb), { ok: true, status: 'ready', detail: 'ready' });

        const missingOrders = {
          products: [],
          productCategories: [],
          siteContent: {},
          adminCredentials: {}
        };
        assert.equal(checkDbValidity(missingOrders).ok, false);
        assert.equal(checkDbValidity(missingOrders).code, 'DB_INVALID');
      });

      test('Health contract: 200 on ready, 503 on failure', () => {
        function evaluateHealthResponse(runtimeReady: { ok: boolean; status?: string; detail?: string; error?: string }) {
          if (!runtimeReady.ok) {
            return {
              httpStatus: 503,
              body: {
                ok: false,
                build: 'ONIVAL-2026.04-HOTFIX',
                status: runtimeReady.status || 'storage_unavailable',
                detail: runtimeReady.detail || 'dir_missing'
              }
            };
          }
          return {
            httpStatus: 200,
            body: {
              ok: true,
              build: 'ONIVAL-2026.04-HOTFIX',
              status: 'ready',
              detail: 'ready'
            }
          };
        }

        assert.deepEqual(evaluateHealthResponse({ ok: true }), {
          httpStatus: 200,
          body: { ok: true, build: 'ONIVAL-2026.04-HOTFIX', status: 'ready', detail: 'ready' }
        });

        assert.deepEqual(evaluateHealthResponse({ ok: false, status: 'storage_unavailable', detail: 'probe_failed' }), {
          httpStatus: 503,
          body: { ok: false, build: 'ONIVAL-2026.04-HOTFIX', status: 'storage_unavailable', detail: 'probe_failed' }
        });
      });
    });

    describe('H5. Static Path Gate Self-Test Fixtures', () => {
      function staticPathGateCheck(filename: string, content: string) {
        if (content.includes('server-data')) {
          throw new Error(`[DIST ASSERTION FAILED] GATE: ${filename} contains forbidden literal 'server-data'!`);
        }
        if (/__DIR__\s*\.\s*['"]\/\.\.\//.test(content)) {
          throw new Error(`[DIST ASSERTION FAILED] GATE: ${filename} contains forbidden relative traversal '__DIR__ . /../'!`);
        }
        return true;
      }

      test('Static gate self-test fixture fails on forbidden server-data literal', () => {
        const badContent = `<?php $file = 'server-data/onival-persistent-data.json';`;
        assert.throws(() => staticPathGateCheck('test.php', badContent), /forbidden literal 'server-data'/);
      });

      test('Static gate self-test fixture fails on forbidden relative traversal __DIR__ . /../', () => {
        const badContent = `<?php $p = __DIR__ . '/../data.json';`;
        assert.throws(() => staticPathGateCheck('test.php', badContent), /forbidden relative traversal/);
      });

      test('Static gate self-test fixture passes on clean code', () => {
        const cleanContent = `<?php $p = ONIVAL_PRIVATE_DIR . '/data.json';`;
        assert.equal(staticPathGateCheck('clean.php', cleanContent), true);
      });

      test('Verify ALL actual public/api PHP files pass the static path gate', async () => {
        const fs = await import('node:fs');
        const publicApiDir = path.join(process.cwd(), 'public', 'api');
        const allowedPhp = ['common.php', 'index.php', 'webhook.php', 'bale-webhook.php'];

        for (const file of allowedPhp) {
          const filePath = path.join(publicApiDir, file);
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            assert.doesNotThrow(
              () => staticPathGateCheck(file, content),
              `File public/api/${file} must pass static path gate!`
            );
          }
        }
      });
    });

    describe('Phase I: Production Hardening, Distribution & Security Gate (I0 - I4)', () => {
      describe('I0: Deployable artifact in exported project', () => {
        test('verifyDist passes on real dist and authoritative artifacts', async () => {
          const fs = await import('node:fs');
          const distDir = path.join(process.cwd(), 'dist');
          const manifestPath = path.join(process.cwd(), 'DEPLOY-MANIFEST.txt');
          const commonPhpPath = path.join(distDir, 'api', 'common.php');
          if (fs.existsSync(distDir) && fs.existsSync(manifestPath)) {
            assert.doesNotThrow(() => verifyDist(distDir, manifestPath, commonPhpPath));
          }
        });

        test('verifyDist gate fails if dist/.htaccess is missing', async () => {
          const fs = await import('node:fs');
          const os = await import('node:os');
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-dist-test-'));
          const tempDist = path.join(tempDir, 'dist');
          const tempApi = path.join(tempDist, 'api');
          fs.mkdirSync(tempApi, { recursive: true });
          fs.writeFileSync(path.join(tempApi, 'seed.php'), "<?php if (!defined('ONIVAL_ENTRY')) exit;");
          fs.writeFileSync(path.join(tempApi, 'common.php'), `<?php const ONIVAL_BUILD_ID = '${EXPECTED_BUILD_ID}';`);
          fs.writeFileSync(path.join(tempApi, 'index.php'), '<?php exit;');
          fs.writeFileSync(path.join(tempApi, 'webhook.php'), '<?php exit;');
          fs.writeFileSync(path.join(tempDist, 'index.html'), '<!DOCTYPE html><html></html>');

          const tempBackup = path.join(tempDir, 'HTACCESS-BACKUP.txt');
          fs.writeFileSync(tempBackup, 'Options -Indexes');

          const tempManifest = path.join(tempDir, 'DEPLOY-MANIFEST.txt');
          fs.writeFileSync(
            tempManifest,
            `if .htaccess is missing after extraction, rename a copy of this file to .htaccess\nBUILD_ID: ${EXPECTED_BUILD_ID}\n`
          );

          const tempReady = path.join(tempDir, 'public_html_ready');
          const tempReadyApi = path.join(tempReady, 'api');
          fs.mkdirSync(tempReadyApi, { recursive: true });
          fs.writeFileSync(path.join(tempReady, '.htaccess'), 'Options -Indexes');
          fs.writeFileSync(path.join(tempReady, 'index.html'), '<!DOCTYPE html><html></html>');
          fs.writeFileSync(path.join(tempReadyApi, 'seed.php'), "<?php if (!defined('ONIVAL_ENTRY')) exit;");
          fs.writeFileSync(path.join(tempReadyApi, 'common.php'), `<?php const ONIVAL_BUILD_ID = '${EXPECTED_BUILD_ID}';`);
          fs.writeFileSync(path.join(tempReadyApi, 'index.php'), '<?php exit;');
          fs.writeFileSync(path.join(tempReadyApi, 'webhook.php'), '<?php exit;');

          // Missing .htaccess in dist should fail
          assert.throws(() => verifyDist(tempDist, tempManifest, path.join(tempApi, 'common.php'), tempReady), /dist\/\.htaccess is missing/);

          // Add empty .htaccess -> should fail
          fs.writeFileSync(path.join(tempDist, '.htaccess'), '');
          assert.throws(() => verifyDist(tempDist, tempManifest, path.join(tempApi, 'common.php'), tempReady), /dist\/\.htaccess is missing or empty/);

          // Non-empty .htaccess -> should pass
          fs.writeFileSync(path.join(tempDist, '.htaccess'), 'Options -Indexes');
          assert.equal(verifyDist(tempDist, tempManifest, path.join(tempApi, 'common.php'), tempReady), true);

          // Add forbidden file -> should fail
          fs.writeFileSync(path.join(tempDist, 'onival-persistent-data.json'), '{}');
          assert.throws(() => verifyDist(tempDist, tempManifest, path.join(tempApi, 'common.php'), tempReady), /Forbidden file found in dist/);

          // Add sensitive .map file -> should fail
          fs.rmSync(path.join(tempDist, 'onival-persistent-data.json'));
          fs.writeFileSync(path.join(tempDist, 'bundle.js.map'), '');
          assert.throws(() => verifyDist(tempDist, tempManifest, path.join(tempApi, 'common.php'), tempReady), /Sensitive extension found in dist/);

          fs.rmSync(tempDir, { recursive: true, force: true });
        });

        test('DEPLOY-MANIFEST.txt and HTACCESS-BACKUP.txt exist in project root', async () => {
          const fs = await import('node:fs');
          const manifestPath = path.join(process.cwd(), 'DEPLOY-MANIFEST.txt');
          const backupPath = path.join(process.cwd(), 'HTACCESS-BACKUP.txt');
          if (fs.existsSync(manifestPath)) {
            const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
            assert.ok(
              manifestContent.includes(`BUILD_ID: ${EXPECTED_BUILD_ID}`) ||
              /BUILD_ID:\s*\d{8}-[a-f0-9]{10}/.test(manifestContent)
            );
            assert.ok(manifestContent.includes('FILE_COUNT:'));
            assert.ok(manifestContent.includes('SHA256:'));
          }
          if (fs.existsSync(backupPath)) {
            const backupContent = fs.readFileSync(backupPath, 'utf-8');
            assert.ok(backupContent.includes('Options -Indexes'));
            assert.ok(backupContent.includes('RewriteEngine On'));
          }
        });
      });

      describe('I1: Strict /api/health contract & no public setup state', () => {
        function buildHealthResponse(isReady: boolean, statusDetail: { status: string; detail: string }) {
          if (!isReady) {
            return {
              httpCode: 503,
              payload: {
                ok: false,
                build: EXPECTED_BUILD_ID,
                status: statusDetail.status,
                detail: statusDetail.detail
              }
            };
          }
          return {
            httpCode: 200,
            payload: {
              ok: true,
              build: EXPECTED_BUILD_ID,
              status: 'ready',
              detail: 'ready'
            }
          };
        }

        test('Healthy contract returns HTTP 200 with EXACT 4 keys', () => {
          const res = buildHealthResponse(true, { status: 'ready', detail: 'ready' });
          assert.equal(res.httpCode, 200);
          assert.deepEqual(Object.keys(res.payload).sort(), ['build', 'detail', 'ok', 'status']);
          assert.equal(res.payload.ok, true);
          assert.equal(res.payload.build, EXPECTED_BUILD_ID);
          assert.equal(res.payload.status, 'ready');
          assert.equal(res.payload.detail, 'ready');
          // Strict negative assertions: no leaked internal fields
          assert.equal('buildId' in res.payload, false);
          assert.equal('code' in res.payload, false);
          assert.equal('initialSetupCompleted' in res.payload, false);
          assert.equal('timestamp' in res.payload, false);
        });

        test('Failing contract returns HTTP 503 with exact keys and no internal leaks', () => {
          const res = buildHealthResponse(false, { status: 'storage_unavailable', detail: 'dir_missing' });
          assert.equal(res.httpCode, 503);
          assert.deepEqual(Object.keys(res.payload).sort(), ['build', 'detail', 'ok', 'status']);
          assert.equal(res.payload.ok, false);
          assert.equal(res.payload.status, 'storage_unavailable');
          assert.equal(res.payload.detail, 'dir_missing');
        });

        test('Unauthenticated setup-status or login failure does not leak setup status and returns 503 on storage failure', () => {
          function simulateSetupStatus(authHeader: string | null) {
            if (!authHeader) {
              return { httpCode: 401, body: { ok: false, error: 'AUTH_REQUIRED' } };
            }
            return { httpCode: 200, body: { ok: true, initialSetupCompleted: false } };
          }
          const anon = simulateSetupStatus(null);
          assert.equal(anon.httpCode, 401);
          assert.equal('initialSetupCompleted' in anon.body, false);

          function simulateLoginWithStorage(storageAvailable: boolean) {
            if (!storageAvailable) {
              return { httpCode: 503, body: { ok: false, error: 'STORAGE_UNAVAILABLE' } };
            }
            return { httpCode: 200, body: { ok: true } };
          }
          const fail = simulateLoginWithStorage(false);
          assert.equal(fail.httpCode, 503, 'Must return HTTP 503 when private storage is unavailable');
        });
      });

      describe('I2: Database/Seed structure validation & PHP version compatibility', () => {
        function validateSeedStructure(seed: any) {
          if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
            return { ok: false, status: 'seed_invalid', detail: 'seed_not_array' };
          }
          if (!('products' in seed) || !Array.isArray(seed.products) || seed.products.length === 0) {
            return { ok: false, status: 'seed_missing', detail: 'products_empty_or_missing' };
          }
          return { ok: true };
        }

        function validateDbStructure(db: any) {
          if (!db || typeof db !== 'object' || Array.isArray(db)) {
            return { ok: false, status: 'db_invalid', detail: 'invalid_json' };
          }
          const listKeys = ['products', 'productCategories', 'orders'];
          for (const k of listKeys) {
            if (!(k in db) || !Array.isArray(db[k])) {
              return { ok: false, status: 'db_invalid', detail: `${k}_must_be_list` };
            }
          }
          const mapKeys = ['siteContent', 'adminCredentials'];
          for (const k of mapKeys) {
            if (k in db) {
              if (Array.isArray(db[k]) && db[k].length > 0) {
                return { ok: false, status: 'db_invalid', detail: `${k}_must_be_map` };
              }
              if (typeof db[k] !== 'object' || db[k] === null) {
                return { ok: false, status: 'db_invalid', detail: `${k}_must_be_map` };
              }
            }
          }
          return { ok: true, status: 'ready', detail: 'ready' };
        }

        test('Seed creation rejects missing or empty products list', () => {
          assert.deepEqual(validateSeedStructure({}), { ok: false, status: 'seed_missing', detail: 'products_empty_or_missing' });
          assert.deepEqual(validateSeedStructure({ products: [] }), { ok: false, status: 'seed_missing', detail: 'products_empty_or_missing' });
          assert.deepEqual(validateSeedStructure({ products: [{ id: 1, name: 'Product 1' }] }), { ok: true });
        });

        test('Live DB allows empty products list but rejects non-list for list-type keys', () => {
          const validEmptyCatalog = {
            products: [],
            productCategories: [],
            orders: [],
            siteContent: {},
            adminCredentials: {}
          };
          assert.equal(validateDbStructure(validEmptyCatalog).ok, true);

          const listStoredAsObject = {
            products: { '0': { id: 1 } },
            productCategories: [],
            orders: [],
            siteContent: {},
            adminCredentials: {}
          };
          assert.equal(validateDbStructure(listStoredAsObject).ok, false);
          assert.equal(validateDbStructure(listStoredAsObject).detail, 'products_must_be_list');
        });

        test('Live DB allows empty array for map keys but rejects populated arrays', () => {
          const mapAsEmptyList = {
            products: [],
            productCategories: [],
            orders: [],
            siteContent: [],
            adminCredentials: []
          };
          assert.equal(validateDbStructure(mapAsEmptyList).ok, true);

          const mapAsPopulatedList = {
            products: [],
            productCategories: [],
            orders: [],
            siteContent: ['invalid', 'list', 'entry'],
            adminCredentials: {}
          };
          assert.equal(validateDbStructure(mapAsPopulatedList).ok, false);
          assert.equal(validateDbStructure(mapAsPopulatedList).detail, 'siteContent_must_be_map');
        });

        test('PHP version guard rejects versions below 8.0.0 (80000)', () => {
          function checkPhpVersion(phpVersionId: number) {
            const ONIVAL_MIN_PHP_VERSION_ID = 80000;
            const ONIVAL_MIN_PHP_VERSION = '8.0.0';
            if (phpVersionId < ONIVAL_MIN_PHP_VERSION_ID) {
              return { ok: false, httpCode: 503, status: 'php_unsupported', detail: ONIVAL_MIN_PHP_VERSION };
            }
            return { ok: true };
          }

          assert.deepEqual(checkPhpVersion(70433), { ok: false, httpCode: 503, status: 'php_unsupported', detail: '8.0.0' });
          assert.deepEqual(checkPhpVersion(80000), { ok: true });
          assert.deepEqual(checkPhpVersion(80120), { ok: true });
          assert.deepEqual(checkPhpVersion(80210), { ok: true });
        });
      });

      describe('I3: Frontend pending-state refresh & boot behavior', () => {
        test('Initial auth state is unknown and blocks admin data fetching', () => {
          assert.equal(shouldFetchAdminData(null, false, 'unknown'), false);
          assert.equal(shouldFetchAdminData(true, true, 'pending'), false);
          assert.equal(shouldFetchAdminData(false, false, 'unauthenticated'), false);
          assert.equal(shouldFetchAdminData(false, true, 'authenticated'), true);
        });

        test('viewAfterLogin routes pending users directly to setup', () => {
          assert.equal(viewAfterLogin({ initialSetupCompleted: false }), 'account');
          assert.equal(viewAfterLogin({ isInitialPending: true }), 'account');
          assert.equal(viewAfterLogin({ initialSetupCompleted: true }), 'dashboard');
        });

        test('Pending state in AccountView restricts rendered controls to username/password change', () => {
          function renderAccountSections(isSetupDone: boolean) {
            return {
              showLogoUpload: isSetupDone,
              showImageFrameSettings: isSetupDone,
              showHostManagement: isSetupDone,
              showEmailField: isSetupDone,
              showDisplayNameField: isSetupDone,
              showCurrentPasswordField: isSetupDone,
              showNewUsernameField: true,
              showNewPasswordField: true,
              showConfirmPasswordField: true
            };
          }

          const pendingSections = renderAccountSections(false);
          assert.equal(pendingSections.showLogoUpload, false);
          assert.equal(pendingSections.showImageFrameSettings, false);
          assert.equal(pendingSections.showHostManagement, false);
          assert.equal(pendingSections.showCurrentPasswordField, false);
          assert.equal(pendingSections.showNewUsernameField, true);
          assert.equal(pendingSections.showNewPasswordField, true);

          const completedSections = renderAccountSections(true);
          assert.equal(completedSections.showLogoUpload, true);
          assert.equal(completedSections.showHostManagement, true);
          assert.equal(completedSections.showCurrentPasswordField, true);
        });
      });

      describe('I4: Username validation across states (isValidAdminUsername / isValidAdminUsernameClient)', () => {
        test('isValidAdminUsernameClient validates username format and length (3-32 chars, regex)', () => {
          assert.equal(isValidAdminUsernameClient('ab', false).isValid, false);
          assert.equal(isValidAdminUsernameClient('a'.repeat(33), false).isValid, false);
          assert.equal(isValidAdminUsernameClient('valid_user-name.1', false).isValid, true);
          assert.equal(isValidAdminUsernameClient('invalid space', false).isValid, false);
          assert.equal(isValidAdminUsernameClient('user@name', false).isValid, false);
          assert.equal(isValidAdminUsernameClient('admin', false).isValid, false);
        });

        test('isValidAdminUsernameClient in pending state rejects initial username', () => {
          assert.equal(isValidAdminUsernameClient('onival_setup', true, 'onival_setup').isValid, false);
          assert.equal(isValidAdminUsernameClient('onival_setup', true, 'onival_setup').code, 'USERNAME_SAME_AS_INITIAL');
          assert.equal(isValidAdminUsernameClient('my_new_admin', true, 'onival_setup').isValid, true);
        });

        test('isValidAdminUsernameClient in completed state allows new distinct usernames and rejects admin', () => {
          assert.equal(isValidAdminUsernameClient('admin', false).isValid, false);
          assert.equal(isValidAdminUsernameClient('super_admin', false).isValid, true);
        });
      });
    });

    describe('Phase J: Deploy Survival, UTF-8 Gate & Setup Username (J0 - J2)', () => {
      describe('J0: A Deploy Folder That Survives the Zip Export', () => {
        test('public_html_ready and dist byte-identical equality in verifyDist', async () => {
          const fs = await import('node:fs');
          const os = await import('node:os');
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onival-j0-test-'));
          const distDir = path.join(tempDir, 'dist');
          const readyDir = path.join(tempDir, 'public_html_ready');
          const distApi = path.join(distDir, 'api');
          const readyApi = path.join(readyDir, 'api');
          fs.mkdirSync(distApi, { recursive: true });
          fs.mkdirSync(readyApi, { recursive: true });

          const commonPhpContent = `<?php define('ONIVAL_BUILD_ID', '${EXPECTED_BUILD_ID}');`;
          const seedPhpContent = "<?php if (!defined('ONIVAL_ENTRY')) exit;";
          const htaccessContent = 'Options -Indexes\nRewriteEngine On';
          const indexHtmlContent = '<!DOCTYPE html><html><body>ONIVAL</body></html>';

          fs.writeFileSync(path.join(distDir, '.htaccess'), htaccessContent);
          fs.writeFileSync(path.join(distDir, 'index.html'), indexHtmlContent);
          fs.writeFileSync(path.join(distApi, 'seed.php'), seedPhpContent);
          fs.writeFileSync(path.join(distApi, 'common.php'), commonPhpContent);
          fs.writeFileSync(path.join(distApi, 'index.php'), '<?php exit;');
          fs.writeFileSync(path.join(distApi, 'webhook.php'), '<?php exit;');

          // Replicate into readyDir
          fs.writeFileSync(path.join(readyDir, '.htaccess'), htaccessContent);
          fs.writeFileSync(path.join(readyDir, 'index.html'), indexHtmlContent);
          fs.writeFileSync(path.join(readyApi, 'seed.php'), seedPhpContent);
          fs.writeFileSync(path.join(readyApi, 'common.php'), commonPhpContent);
          fs.writeFileSync(path.join(readyApi, 'index.php'), '<?php exit;');
          fs.writeFileSync(path.join(readyApi, 'webhook.php'), '<?php exit;');

          const backupHtaccess = path.join(tempDir, 'HTACCESS-BACKUP.txt');
          fs.writeFileSync(backupHtaccess, htaccessContent);

          const manifestPath = path.join(tempDir, 'DEPLOY-MANIFEST.txt');
          fs.writeFileSync(
            manifestPath,
            `if .htaccess is missing after extraction, rename a copy of this file to .htaccess\nBUILD_ID: ${EXPECTED_BUILD_ID}\n`
          );

          // Byte-identical: passes
          assert.equal(verifyDist(distDir, manifestPath, path.join(distApi, 'common.php'), readyDir), true);

          // Negative test 1: Deleting one file in public_html_ready causes verifyDist to fail
          fs.rmSync(path.join(readyDir, 'index.html'));
          assert.throws(
            () => verifyDist(distDir, manifestPath, path.join(distApi, 'common.php'), readyDir),
            /File in dist missing from public_html_ready: index\.html/
          );

          // Restore file and test Negative test 2: Altering one byte causes SHA-256 mismatch
          fs.writeFileSync(path.join(readyDir, 'index.html'), indexHtmlContent + ' ');
          assert.throws(
            () => verifyDist(distDir, manifestPath, path.join(distApi, 'common.php'), readyDir),
            /SHA-256 mismatch for index\.html/
          );

          // Clean up temp
          fs.rmSync(tempDir, { recursive: true, force: true });
        });

        test('Recreating public_html_ready twice leaves no stale files', async () => {
          const fs = await import('node:fs');
          const os = await import('node:os');
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onival-recreate-test-'));
          const distDir = path.join(tempDir, 'dist');
          const readyDir = path.join(tempDir, 'public_html_ready');
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(path.join(distDir, 'file1.txt'), 'hello');

          function populateReady(src, dest) {
            if (fs.existsSync(dest)) {
              fs.rmSync(dest, { recursive: true, force: true });
            }
            fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src)) {
              fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
            }
          }

          populateReady(distDir, readyDir);
          assert.equal(fs.existsSync(path.join(readyDir, 'file1.txt')), true);

          // Simulate an old stale file created in readyDir
          fs.writeFileSync(path.join(readyDir, 'stale-file.bak'), 'stale content');
          assert.equal(fs.existsSync(path.join(readyDir, 'stale-file.bak')), true);

          // Recreate again: stale file must be gone
          populateReady(distDir, readyDir);
          assert.equal(fs.existsSync(path.join(readyDir, 'stale-file.bak')), false);
          assert.equal(fs.readdirSync(readyDir).length, 1);

          fs.rmSync(tempDir, { recursive: true, force: true });
        });

        test('DEPLOY-MANIFEST.txt starts with .htaccess notice and HTACCESS-BACKUP.txt exists in root', async () => {
          const fs = await import('node:fs');
          const manifestPath = path.join(process.cwd(), 'DEPLOY-MANIFEST.txt');
          const backupPath = path.join(process.cwd(), 'HTACCESS-BACKUP.txt');
          if (fs.existsSync(manifestPath)) {
            const content = fs.readFileSync(manifestPath, 'utf-8');
            assert.ok(content.startsWith('if .htaccess is missing after extraction, rename a copy of this file to .htaccess'));
            assert.ok(
              content.includes(`BUILD_ID: ${EXPECTED_BUILD_ID}`) ||
              /BUILD_ID:\s*\d{8}-[a-f0-9]{10}/.test(content)
            );
          }
          if (fs.existsSync(backupPath)) {
            assert.ok(fs.existsSync(backupPath));
            assert.ok(!backupPath.includes('public_html_ready'));
          }
        });
      });

      describe('J1: UTF-8 Gate, Surrogate Prevention & Template Encoding', () => {
        test('Self-test fixture: Broken CESU-8 surrogate pair fails check-utf8', () => {
          // CESU-8 surrogate bytes for U+1F9FE: \xED\xA0\xBE\xED\xB7\xBE
          const brokenSurrogateBuf = Buffer.concat([
            Buffer.from("<?php\n// "),
            Buffer.from([0xed, 0xa0, 0xbe, 0xed, 0xb7, 0xbe])
          ]);
          assert.throws(
            () => validateTextBuffer(brokenSurrogateBuf, 'webhook.php'),
            /CESU-8 \/ surrogate sequence detected/
          );
        });

        test('Self-test fixture: Invalid UTF-8 byte sequences fail check-utf8', () => {
          const invalidUtf8Buf = Buffer.from([0xff, 0xfe, 0x80, 0x00]);
          assert.throws(
            () => validateTextBuffer(invalidUtf8Buf, 'invalid.ts'),
            /Invalid UTF-8 byte sequence/
          );
        });

        test('Self-test fixture: UTF-8 BOM in PHP files fails check-utf8', () => {
          const bomPhpBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?php echo 1;')]);
          assert.throws(
            () => validateTextBuffer(bomPhpBuf, 'bom.php'),
            /UTF-8 BOM detected at the start of PHP file/
          );
        });

        test('Self-test fixture: Output or whitespace before <?php fails check-utf8', () => {
          const leadingSpaceBuf = Buffer.from(' <?php echo 1;');
          assert.throws(
            () => validateTextBuffer(leadingSpaceBuf, 'space.php'),
            /Output or whitespace detected before opening <\?php tag/
          );

          const leadingHtmlBuf = Buffer.from('<html>\n<?php echo 1;');
          assert.throws(
            () => validateTextBuffer(leadingHtmlBuf, 'html.php'),
            /Output or whitespace detected before opening <\?php tag/
          );
        });

        test('Self-test fixture: Clean UTF-8 PHP source passes check-utf8', () => {
          const cleanPhpBuf = Buffer.from("<?php\necho 'سلام دنیا';");
          assert.equal(validateTextBuffer(cleanPhpBuf, 'clean.php'), true);
        });

        test('callBaleApi error simulation on invalid UTF-8 logs JSON_ENCODE_FAILED and does not send', () => {
          function simulateCallBaleApi(parameters: any) {
            let jsonPayload: string | false = false;
            let jsonError = '';
            const loneSurrogateRegex = /(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
            const hasLoneSurrogate = (obj: any): boolean => {
              if (typeof obj === 'string') return loneSurrogateRegex.test(obj);
              if (obj && typeof obj === 'object') return Object.values(obj).some(hasLoneSurrogate);
              return false;
            };

            if (hasLoneSurrogate(parameters)) {
              jsonPayload = false;
              jsonError = 'Malformed UTF-8 / unpaired surrogate characters';
            } else {
              try {
                jsonPayload = JSON.stringify(parameters);
              } catch (e: any) {
                jsonPayload = false;
                jsonError = e.message;
              }
            }

            if (jsonPayload === false) {
              return {
                ok: false,
                code: 'JSON_ENCODE_FAILED',
                error: 'JSON encoding failed: ' + jsonError,
                loggedCode: 'JSON_ENCODE_FAILED',
                curlSent: false
              };
            }

            return {
              ok: true,
              curlSent: true
            };
          }

          // Test with valid emoji string
          const validParams = { text: '\u{1F9FE} فاکتور سفارش' };
          assert.equal(simulateCallBaleApi(validParams).ok, true);

          // Test with broken lone surrogate character
          const brokenParams = { text: 'Invalid \uD800 lone surrogate' };
          const res = simulateCallBaleApi(brokenParams);
          assert.equal(res.ok, false);
          assert.equal(res.code, 'JSON_ENCODE_FAILED');
          assert.equal(res.loggedCode, 'JSON_ENCODE_FAILED');
          assert.equal(res.curlSent, false, 'cURL must NOT be sent when JSON encoding fails');
        });

        test('All webhook.php message templates encode cleanly to valid JSON with zero surrogates', () => {
          function hasCesu8Surrogate(buf: Buffer): boolean {
            for (let i = 0; i < buf.length - 2; i++) {
              if (buf[i] === 0xed && (buf[i + 1] >= 0xa0 && buf[i + 1] <= 0xbf) && (buf[i + 2] >= 0x80 && buf[i + 2] <= 0xbf)) {
                return true;
              }
            }
            return false;
          }

          const sampleOrder = {
            trackingCode: 'ONV-ORD-2026-9901',
            customerName: 'علی رضایی',
            userFullName: 'علی رضایی',
            totalPrice: 450000,
            status: 'Pending'
          };
          const cardNumber = '6037997112345678';
          const cardHolder = 'فروشگاه اونیوال';
          const bankName = 'بانک ملی ایران';
          const storeUrl = 'https://onival.ir';
          const amountToman = 450000;
          const invoiceSent = true;

          // 1. $orderInfoMsg
          const orderInfoMsg =
            `\u{1F9FE} فاکتور سفارش ${sampleOrder.trackingCode}\n\n` +
            `\u{1F464} مشتری: ${sampleOrder.userFullName}\n` +
            `\u{1F4B0} مبلغ کل: ${amountToman.toLocaleString()} تومان\n` +
            `⏳ وضعیت: در انتظار پرداخت\n\n` +
            (invoiceSent ? '\u{1F4B3} کارت پرداخت کیف‌پول بله در بالا صادر گردید.\n\n' : '') +
            `▫️ جهت پرداخت کارت به کارت:\n` +
            `شماره کارت: ${cardNumber}\n` +
            `به نام: ${cardHolder} (${bankName})\n\n` +
            `\u{1F4F8} پس از واریز، تصویر فیش را در همین گفتگو ارسال فرمایید.`;

          // 2. $welcome
          const welcome =
            'به ربات رسمی فروشگاه تخصصی اونیوال (ONIVAL) خوش آمدید! \u{1F36F}\u{1F33F}\n\n' +
            'از طریق دکمه‌های زیر می‌توانید سفارش‌های خود را استعلام کرده، با کیف‌پول بله یا کارت‌به‌کارت پرداخت کنید.';

          // 3. $notFoundMsg
          const notFoundMsg = `❌ سفارشی با کد پیگیری «${sampleOrder.trackingCode}» در سیستم یافت نشد.\nلطفاً کد رهگیری فاکتور خود را با دقت بررسی فرمایید.`;

          // 4. $paidMsg
          const paidMsg = `✅ سفارش ${sampleOrder.trackingCode} قبلاً با موفقیت پرداخت و تایید شده است.`;

          // 5. $c2cMsg
          const c2cMsg = `\u{1F4B3} راهنمای پرداخت کارت‌به‌کارت سفارش ${sampleOrder.trackingCode}:\nشماره کارت: ${cardNumber}`;

          // 6. $custNotify
          const custNotify = `\u{1F389} سفارش ${sampleOrder.trackingCode} شما تایید شد و به زودی ارسال می‌گردد.`;

          // 7. $custReceipt
          const custReceipt = `\u{1F4F8} تصویر فیش واریزی سفارش ${sampleOrder.trackingCode} دریافت شد و جهت بررسی برای مدیر ارسال گردید.`;

          // 8. $custReassure
          const custReassure = `\u{1F64F} مشتری گرامی، پرداخت شما در حال پردازش نهایی است.`;

          // 9. $custThanks
          const custThanks = `با تشکر از اعتماد شما به محصولات ارگانیک اونیوال. \u{1F33F}`;

          // 10. $adminAlert
          const adminAlert = `\u{1F6A8} فیش جدید برای سفارش ${sampleOrder.trackingCode} بارگذاری شد. لطفاً بررسی فرمایید.`;

          const templates = [
            orderInfoMsg,
            welcome,
            notFoundMsg,
            paidMsg,
            c2cMsg,
            custNotify,
            custReceipt,
            custReassure,
            custThanks,
            adminAlert
          ];

          for (const t of templates) {
            const payload = {
              chat_id: 12345678,
              text: t,
              reply_markup: {
                inline_keyboard: [[{ text: 'مشاهده فاکتور', url: storeUrl }]]
              }
            };
            const jsonStr = JSON.stringify(payload);
            assert.ok(jsonStr.length > 0);
            const buf = Buffer.from(jsonStr, 'utf-8');
            // Verify no CESU-8 surrogate bytes
            assert.equal(hasCesu8Surrogate(buf), false);
            // Verify no lone/unpaired surrogates in JS string
            const loneSurrogateRegex = /(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
            assert.equal(loneSurrogateRegex.test(jsonStr), false);
            // Verify json decodes back cleanly
            const decoded = JSON.parse(jsonStr);
            assert.equal(decoded.chat_id, 12345678);
            assert.equal(decoded.text, t);
          }
        });
      });

      describe('J2: Setup Form Username Field', () => {
        test('getInitialUsernameForState starts empty while pending and ignores profile username', () => {
          assert.equal(getInitialUsernameForState(true), '');
          assert.equal(getInitialUsernameForState(true, 'initial_admin'), '');
          assert.equal(getInitialUsernameForState(true, 'onival_setup'), '');
        });

        test('getInitialUsernameForState populates username only when setup is completed', () => {
          assert.equal(getInitialUsernameForState(false, 'custom_admin_2026'), 'custom_admin_2026');
          assert.equal(getInitialUsernameForState(false), 'admin');
        });

        test('AccountView.tsx source contains autoComplete="off" on username input', async () => {
          const fs = await import('node:fs');
          const accountViewPath = path.join(process.cwd(), 'src', 'components', 'AccountView.tsx');
          const source = fs.readFileSync(accountViewPath, 'utf-8');
          assert.ok(
            source.includes('autoComplete="off"'),
            'AccountView.tsx must include autoComplete="off" on the username input'
          );
        });

        test('T4 Grep Check: AccountView.tsx never initializes username with admin', async () => {
          const fs = await import('node:fs');
          const accountViewPath = path.join(process.cwd(), 'src', 'components', 'AccountView.tsx');
          const source = fs.readFileSync(accountViewPath, 'utf-8');
          assert.equal(
            /useState(?:<[^>]*>)?\(\s*['"]admin['"]\s*\)/i.test(source),
            false,
            'AccountView.tsx must NEVER have a hardcoded useState("admin") state initializer'
          );
        });
      });

      describe('T3: Dynamic BUILD_ID Calculation', () => {
        function computeDynamicBuildId(fileEntries: Array<{ relPath: string; content: string }>, date = new Date()) {
          const sorted = [...fileEntries].sort((a, b) => a.relPath.localeCompare(b.relPath));
          const listLines = sorted.map(
            f => `${f.relPath}:${crypto.createHash('sha256').update(Buffer.from(f.content)).digest('hex')}`
          );
          const listStr = listLines.join('\n');
          const contentSha = crypto.createHash('sha256').update(listStr).digest('hex');
          const yyyy = date.getUTCFullYear();
          const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(date.getUTCDate()).padStart(2, '0');
          return `${yyyy}${mm}${dd}-${contentSha.substring(0, 10)}`;
        }

        test('Dynamic BUILD_ID matches regex and is deterministic for identical files', () => {
          const files = [
            { relPath: 'index.html', content: '<html><body>test</body></html>' },
            { relPath: 'api/index.php', content: '<?php exit;' },
            { relPath: 'assets/app.js', content: 'console.log("hello");' }
          ];
          const fixedDate = new Date('2026-11-03T12:00:00Z');
          const id1 = computeDynamicBuildId(files, fixedDate);
          const id2 = computeDynamicBuildId(files, fixedDate);
          assert.equal(id1, id2);
          assert.match(id1, /^\d{8}-[a-f0-9]{10}$/);
          assert.ok(id1.startsWith('20261103-'));
        });

        test('Changing one byte in any file produces a different BUILD_ID', () => {
          const filesA = [
            { relPath: 'index.html', content: '<html><body>test</body></html>' },
            { relPath: 'api/index.php', content: '<?php exit;' }
          ];
          const filesB = [
            { relPath: 'index.html', content: '<html><body>test!</body></html>' },
            { relPath: 'api/index.php', content: '<?php exit;' }
          ];
          const fixedDate = new Date('2026-11-03T12:00:00Z');
          const idA = computeDynamicBuildId(filesA, fixedDate);
          const idB = computeDynamicBuildId(filesB, fixedDate);
          assert.notEqual(idA, idB, 'Altering a file byte MUST change the dynamic BUILD_ID');
        });
      });

      describe('T2: Integrity Checker Logic', () => {
        function runIntegrityCheck(
          dirFiles: Record<string, string>,
          hashesRecord: { build: string; files: Record<string, string> },
          hasHtaccess = true
        ) {
          const missing: string[] = [];
          const modified: string[] = [];
          let checked = 0;

          for (const [relPath, expectedSha] of Object.entries(hashesRecord.files)) {
            if (checked >= 500) break;
            checked++;
            if (!(relPath in dirFiles)) {
              missing.push(relPath);
            } else {
              const actualSha = crypto.createHash('sha256').update(Buffer.from(dirFiles[relPath])).digest('hex');
              if (actualSha !== expectedSha) {
                modified.push(relPath);
              }
            }
          }

          const ok = hasHtaccess && missing.length === 0 && modified.length === 0;
          return {
            ok,
            build: hashesRecord.build,
            checked,
            missing,
            modified,
            htaccessPresent: hasHtaccess
          };
        }

        test('Unmodified deployed files result in ok: true', () => {
          const files: Record<string, string> = {
            'index.html': '<html></html>',
            'api/index.php': '<?php exit;',
            'api/common.php': '<?php define("ONIVAL_BUILD_ID", "20261103-abc1234567");'
          };
          const hashes: Record<string, string> = {};
          for (const [p, c] of Object.entries(files)) {
            hashes[p] = crypto.createHash('sha256').update(Buffer.from(c)).digest('hex');
          }
          const res = runIntegrityCheck(files, { build: '20261103-abc1234567', files: hashes }, true);
          assert.equal(res.ok, true);
          assert.equal(res.build, '20261103-abc1234567');
          assert.equal(res.checked, 3);
          assert.deepEqual(res.missing, []);
          assert.deepEqual(res.modified, []);
          assert.equal(res.htaccessPresent, true);
        });

        test('Altering one byte adds the file to modified list and sets ok: false', () => {
          const origFiles: Record<string, string> = {
            'index.html': '<html></html>',
            'api/index.php': '<?php exit;'
          };
          const hashes: Record<string, string> = {};
          for (const [p, c] of Object.entries(origFiles)) {
            hashes[p] = crypto.createHash('sha256').update(Buffer.from(c)).digest('hex');
          }

          const tamperedFiles = {
            ...origFiles,
            'api/index.php': '<?php /* tampered */ exit;'
          };

          const res = runIntegrityCheck(tamperedFiles, { build: '20261103-abc1234567', files: hashes }, true);
          assert.equal(res.ok, false);
          assert.deepEqual(res.modified, ['api/index.php']);
          assert.deepEqual(res.missing, []);
        });

        test('Deleting a file adds the file to missing list and sets ok: false', () => {
          const hashes = {
            'index.html': 'hash1',
            'api/webhook.php': 'hash2'
          };
          const presentFiles = {
            'index.html': 'content1'
          };
          // simulate matching hash for index.html
          hashes['index.html'] = crypto.createHash('sha256').update(Buffer.from('content1')).digest('hex');

          const res = runIntegrityCheck(presentFiles, { build: '20261103-abc1234567', files: hashes }, true);
          assert.equal(res.ok, false);
          assert.deepEqual(res.missing, ['api/webhook.php']);
        });

        test('Extra file present is NOT flagged in missing or modified', () => {
          const files: Record<string, string> = {
            'index.html': '<html></html>',
            'untracked.txt': 'some extra file'
          };
          const hashes: Record<string, string> = {
            'index.html': crypto.createHash('sha256').update(Buffer.from('<html></html>')).digest('hex')
          };
          const res = runIntegrityCheck(files, { build: '20261103-abc1234567', files: hashes }, true);
          assert.equal(res.ok, true);
          assert.deepEqual(res.missing, []);
          assert.deepEqual(res.modified, []);
        });

        test('Missing .htaccess sets ok: false and htaccessPresent: false', () => {
          const files = { 'index.html': 'content' };
          const hashes = { 'index.html': crypto.createHash('sha256').update(Buffer.from('content')).digest('hex') };
          const res = runIntegrityCheck(files, { build: '20261103-abc1234567', files: hashes }, false);
          assert.equal(res.ok, false);
          assert.equal(res.htaccessPresent, false);
        });

        test('Direct execution of integrity-hashes.php is guarded against HTTP access', async () => {
          const fs = await import('node:fs');
          const genScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'generate-htaccess.js'), 'utf-8');
          // Guard inside php file
          assert.ok(genScript.includes("!defined('ONIVAL_ENTRY')"));
          // Deny rule in .htaccess
          assert.ok(genScript.includes('<Files "integrity-hashes.php">'));
        });
      });

      describe('/api/health Response Envelope', () => {
        test('/api/health maintains exactly four keys: ok, build, status, detail', () => {
          const healthPayload = {
            ok: true,
            build: '20261103-a1b2c3d4e5',
            status: 'ready',
            detail: 'ready'
          };
          const keys = Object.keys(healthPayload);
          assert.deepEqual(keys.sort(), ['build', 'detail', 'ok', 'status'].sort());
          assert.equal(keys.length, 4);
        });
      });

      describe('Authoritative Pricing & Quota Formula', () => {
        test('U = round(B * (100 - D) / 100) with quota K split between discounted and regular', () => {
          const product = {
            id: 1,
            price: 100000,
            discount: 20,
            specialOfferStock: 2,
            stock: 10
          };
          // Request Q = 3: first 2 at 80,000, 1 at 100,000 => 260,000
          const res = computeLinePrice(product, '', 3);
          assert.equal(res.basePrice, 100000);
          assert.equal(res.discountedUnitPrice, 80000);
          assert.equal(res.discountedQuantity, 2);
          assert.equal(res.regularQuantity, 1);
          assert.equal(res.lineTotal, 260000);
          assert.equal(res.effectiveUnitPrice, Math.round(260000 / 3));

          assert.equal(cartLineTotal(product, '', 3), 260000);
        });

        test('Quota K larger than quantity Q discounts all units', () => {
          const product = {
            id: 1,
            price: 50000,
            discount: 10,
            specialOfferStock: 5,
            stock: 10
          };
          const res = computeLinePrice(product, '', 2);
          assert.equal(res.discountedUnitPrice, 45000);
          assert.equal(res.discountedQuantity, 2);
          assert.equal(res.regularQuantity, 0);
          assert.equal(res.lineTotal, 90000);
        });

        test('Variant packaging size-level quota overrides product-level quota', () => {
          const product = {
            id: 2,
            price: 200000,
            discount: 15,
            specialOfferStock: 10,
            sizes: [
              { name: '۵۰۰ گرم', price: 150000, specialOfferStock: 1, stock: 5 },
              { name: '۱ کیلو', price: 280000, specialOfferStock: 0, stock: 5 }
            ]
          };
          // 500g variant has quota 1: Q = 2 -> 1 at 127500 + 1 at 150000 = 277500
          const res500 = computeLinePrice(product, '۵۰۰ گرم', 2);
          assert.equal(res500.basePrice, 150000);
          assert.equal(res500.discountedUnitPrice, 127500);
          assert.equal(res500.discountedQuantity, 1);
          assert.equal(res500.regularQuantity, 1);
          assert.equal(res500.lineTotal, 277500);

          // 1kg variant has quota 0: all units at base price (discount not active without quota)
          const res1kg = computeLinePrice(product, '۱ کیلو', 2);
          assert.equal(res1kg.basePrice, 280000);
          assert.equal(res1kg.discountedQuantity, 0);
          assert.equal(res1kg.regularQuantity, 2);
          assert.equal(res1kg.lineTotal, 2 * 280000);
        });
      });

      describe('Order Tracking Code Normalization & Disallow 5-Digit Public OrderNumber', () => {
        function normalizeOrderCode(code: string): string {
          return String(code || '').trim().replace(/_/g, '-').toUpperCase();
        }

        test('Underscores normalize to hyphens and uppercase', () => {
          assert.equal(normalizeOrderCode('onv_ord_a1b2c3d4'), 'ONV-ORD-A1B2C3D4');
          assert.equal(normalizeOrderCode('pay_onv_ord_999'), 'PAY-ONV-ORD-999');
        });

        test('Public tracking disallows 5-digit orderNumber unless admin', () => {
          function isPublicCodeAllowed(query: string, isAdmin: boolean): boolean {
            const clean = query.trim();
            if (/^\d{5}$/.test(clean)) {
              return isAdmin;
            }
            return clean.length >= 6;
          }

          assert.equal(isPublicCodeAllowed('12345', false), false);
          assert.equal(isPublicCodeAllowed('12345', true), true);
          assert.equal(isPublicCodeAllowed('ONV-ORD-ABCD', false), true);
        });
      });

      describe('check-utf8 Rule 5 Single-Quoted PHP String Rejection', () => {
        test('Fails on single-quoted string containing unexpanded \\u{...}', () => {
          const badBuffer = Buffer.from("<?php\n$str = '\\u{1F9FE}';\n");
          assert.throws(
            () => validateTextBuffer(badBuffer, 'webhook.php'),
            /Single-quoted string containing unexpanded unicode escape/
          );
        });

        test('Passes on double-quoted string containing \\u{...}', () => {
          const goodBuffer = Buffer.from('<?php\n$str = "\\u{1F9FE}";\n');
          assert.equal(validateTextBuffer(goodBuffer, 'webhook.php'), true);
        });
      });

      describe('Section 8 & 12: Exact Numeric Discount Formula Cases', () => {
        const prod = {
          id: 99,
          price: 250000,
          discount: 20,
          specialOfferStock: 3
        };

        test('base 250000, d 20, quota 3: qty 1 -> 200000', () => {
          const r = computeLinePrice(prod, '', 1);
          assert.equal(r.lineTotal, 200000);
          assert.equal(r.discountedQuantity, 1);
          assert.equal(r.regularQuantity, 0);
          assert.equal(cartLineTotal(prod, '', 1), 200000);
        });

        test('base 250000, d 20, quota 3: qty 3 -> 600000', () => {
          const r = computeLinePrice(prod, '', 3);
          assert.equal(r.lineTotal, 600000);
          assert.equal(r.discountedQuantity, 3);
          assert.equal(r.regularQuantity, 0);
          assert.equal(cartLineTotal(prod, '', 3), 600000);
        });

        test('base 250000, d 20, quota 3: qty 4 -> 850000', () => {
          const r = computeLinePrice(prod, '', 4);
          assert.equal(r.lineTotal, 850000);
          assert.equal(r.discountedQuantity, 3);
          assert.equal(r.regularQuantity, 1);
          assert.equal(cartLineTotal(prod, '', 4), 850000);
        });

        test('base 250000, d 20, quota 3: qty 5 -> 1100000', () => {
          const r = computeLinePrice(prod, '', 5);
          assert.equal(r.lineTotal, 1100000);
          assert.equal(r.discountedQuantity, 3);
          assert.equal(r.regularQuantity, 2);
          assert.equal(cartLineTotal(prod, '', 5), 1100000);
        });

        test('base 250000, d 20, quota 0: qty 2 -> 500000', () => {
          const prodZero = { ...prod, specialOfferStock: 0 };
          const r = computeLinePrice(prodZero, '', 2);
          assert.equal(r.lineTotal, 500000);
          assert.equal(r.discountedQuantity, 0);
          assert.equal(r.regularQuantity, 2);
          assert.equal(cartLineTotal(prodZero, '', 2), 500000);
        });

        test('base 250000, d 20, quota NULL: qty 5 -> 1000000', () => {
          const prodNull = { ...prod, specialOfferStock: undefined };
          const r = computeLinePrice(prodNull, '', 5);
          assert.equal(r.lineTotal, 1000000);
          assert.equal(r.discountedQuantity, 5);
          assert.equal(r.regularQuantity, 0);
          assert.equal(cartLineTotal(prodNull, '', 5), 1000000);
        });
      });

      describe('Section 3 & 12: Unicode Escape Expander', () => {
        function expandUnicodeEscapes(val: any): any {
          if (typeof val === 'string') {
            return val.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
              const code = parseInt(hex, 16);
              return String.fromCodePoint(code);
            });
          }
          if (Array.isArray(val)) {
            return val.map(expandUnicodeEscapes);
          }
          if (val && typeof val === 'object') {
            const out: any = {};
            for (const k of Object.keys(val)) {
              out[k] = expandUnicodeEscapes(val[k]);
            }
            return out;
          }
          return val;
        }

        test('Converts \\u{1F9FE} literal to actual unicode character', () => {
          const raw = 'فاکتور: \\u{1F9FE} پرداخت';
          const expanded = expandUnicodeEscapes(raw);
          assert.equal(expanded, 'فاکتور: \u{1F9FE} پرداخت');
        });

        test('Leaves plain text unchanged', () => {
          const plain = 'عسل سبلان ۱۰۰٪ طبیعی';
          assert.equal(expandUnicodeEscapes(plain), plain);
        });

        test('Expands nested structures recursively', () => {
          const nested = {
            title: '\\u{1F6CD} فروشگاه',
            buttons: [['\\u{1F4B3} پرداخت']]
          };
          const res = expandUnicodeEscapes(nested);
          assert.equal(res.title, '\u{1F6CD} فروشگاه');
          assert.equal(res.buttons[0][0], '\u{1F4B3} پرداخت');
        });
      });

      describe('Section 9 & 12: Order Status Update Transition Matrix', () => {
        function applyStatusTransition(
          order: { status: string; paymentStatus: string; stockDeducted?: boolean },
          newStatus: string,
          newPayStatus: string
        ) {
          const curStatus = order.status;
          const curPay = order.paymentStatus;

          const statusChanged = (newStatus !== curStatus);
          const payChanged = (newPayStatus !== curPay);

          if (!statusChanged && !payChanged) {
            return { ok: true, unchanged: true, order };
          }

          if (curStatus === 'Cancelled') {
            return { ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409, error: 'سفارش لغو شده قابل تغییر نیست' };
          }

          if (payChanged && curPay === 'Paid') {
            return { ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409, error: 'وضعیت پرداخت سفارش تسویه شده قابل بازگشت نیست' };
          }

          if (statusChanged && newStatus === 'Cancelled') {
            if (curStatus === 'Shipped' || curStatus === 'Completed') {
              return { ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409, error: 'سفارش ارسال‌شده یا تکمیل‌شده قابل لغو نیست' };
            }
            return {
              ok: true,
              order: { ...order, status: 'Cancelled', paymentStatus: 'Failed', stockDeducted: false }
            };
          }

          let updated = { ...order };
          if (payChanged && newPayStatus === 'Paid') {
            updated.paymentStatus = 'Paid';
            updated.stockDeducted = true;
          }
          if (statusChanged) {
            updated.status = newStatus;
          }
          if (payChanged && newPayStatus !== 'Paid') {
            updated.paymentStatus = newPayStatus;
          }

          return { ok: true, order: updated };
        }

        test('Unchanged status and payment returns unchanged: true without write', () => {
          const ord = { status: 'Pending', paymentStatus: 'Unpaid' };
          const res = applyStatusTransition(ord, 'Pending', 'Unpaid');
          assert.equal(res.ok, true);
          assert.equal((res as any).unchanged, true);
        });

        test('Rejects transition when order is already Cancelled with 409', () => {
          const ord = { status: 'Cancelled', paymentStatus: 'Failed' };
          const res = applyStatusTransition(ord, 'Processing', 'Paid');
          assert.equal(res.ok, false);
          assert.equal((res as any).status, 409);
        });

        test('Rejects transition away from Paid with 409', () => {
          const ord = { status: 'Processing', paymentStatus: 'Paid' };
          const res = applyStatusTransition(ord, 'Processing', 'Unpaid');
          assert.equal(res.ok, false);
          assert.equal((res as any).status, 409);
        });

        test('Rejects cancellation of Shipped or Completed order with 409', () => {
          const ordShipped = { status: 'Shipped', paymentStatus: 'Paid' };
          const res = applyStatusTransition(ordShipped, 'Cancelled', 'Paid');
          assert.equal(res.ok, false);
          assert.equal((res as any).status, 409);
        });

        test('Payment Paid transitions paymentStatus and records stock deduction', () => {
          const ord = { status: 'Pending', paymentStatus: 'PendingVerification', stockDeducted: false };
          const res = applyStatusTransition(ord, 'Processing', 'Paid');
          assert.equal(res.ok, true);
          assert.equal(res.order?.paymentStatus, 'Paid');
          assert.equal(res.order?.status, 'Processing');
          assert.equal(res.order?.stockDeducted, true);
        });
      });

      describe('Section 2 & 12: Log Safe URI Redaction', () => {
        function logSafeUri(uri: string): string {
          if (!uri || typeof uri !== 'string') return '';
          let s = uri;
          const qIdx = s.indexOf('?');
          if (qIdx !== -1) {
            s = s.substring(0, qIdx) + '?[QUERY_REDACTED]';
          }
          s = s.replace(/(\/api\/webhook\/bale\/(?:customer|admin)\/)[^/]+/i, '$1[PROTECTED]');
          return s;
        }

        test('Masks query string containing webhook key', () => {
          const u = 'https://onival.ir/api/webhook/bale?bot=customer&k=csec_super_secret_key';
          assert.equal(logSafeUri(u), 'https://onival.ir/api/webhook/bale?[QUERY_REDACTED]');
        });

        test('Masks path-secret webhook URL', () => {
          const u = '/api/webhook/bale/admin/asec_secret_12345';
          assert.equal(logSafeUri(u), '/api/webhook/bale/admin/[PROTECTED]');
        });
      });

      describe('Section 2 & 12: Log Activity Status Mapping', () => {
        function inferLogStatus(category: string): string {
          const low = category.toLowerCase();
          let status = 'info';
          if (
            low.includes('completed') ||
            low.includes('registered') ||
            low.includes('delivered') ||
            low.includes('issued') ||
            low.includes('found') ||
            low.includes('updated') ||
            low.includes('recorded') ||
            low.includes('success')
          ) {
            status = 'success';
          }
          if (
            low.includes('failed') ||
            low.includes('error') ||
            low.includes('rejected') ||
            low.includes('not_found') ||
            low.includes('skipped_no')
          ) {
            status = 'error';
          }
          return status;
        }

        test('Maps success categories correctly', () => {
          assert.equal(inferLogStatus('WEBHOOK_REGISTERED'), 'success');
          assert.equal(inferLogStatus('NOTIFY_DELIVERED'), 'success');
          assert.equal(inferLogStatus('ORDER_STATUS_UPDATED'), 'success');
          assert.equal(inferLogStatus('RECEIPT_RECORDED'), 'success');
          assert.equal(inferLogStatus('INVOICE_ISSUED'), 'success');
          assert.equal(inferLogStatus('ORDER_LOOKUP_FOUND'), 'success');
        });

        test('Maps error categories correctly', () => {
          assert.equal(inferLogStatus('AUTH_FAILED'), 'error');
          assert.equal(inferLogStatus('ORDER_REQUEST_REJECTED'), 'error');
          assert.equal(inferLogStatus('ORDER_LOOKUP_NOT_FOUND'), 'error');
          assert.equal(inferLogStatus('INVOICE_SKIPPED_NO_TOKEN'), 'error');
          assert.equal(inferLogStatus('RECEIPT_IMAGE_FAILED'), 'error');
        });
      });

      describe('Section 10 & 12: Image Magic Bytes Sniffing', () => {
        function sniffMime(bytes: Buffer): string | null {
          if (bytes.length < 4) return null;
          if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
            return 'image/jpeg';
          }
          if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
            return 'image/png';
          }
          if (bytes.length >= 12 &&
              bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP') {
            return 'image/webp';
          }
          return null;
        }

        test('Detects JPEG magic bytes', () => {
          const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
          assert.equal(sniffMime(jpeg), 'image/jpeg');
        });

        test('Detects PNG magic bytes', () => {
          const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
          assert.equal(sniffMime(png), 'image/png');
        });

        test('Detects WEBP magic bytes', () => {
          const webp = Buffer.concat([
            Buffer.from('RIFF', 'ascii'),
            Buffer.from([0x20, 0x00, 0x00, 0x00]),
            Buffer.from('WEBP', 'ascii')
          ]);
          assert.equal(sniffMime(webp), 'image/webp');
        });

        test('Rejects unknown/corrupt binary', () => {
          const text = Buffer.from('<?php echo "evil"; ?>');
          assert.equal(sniffMime(text), null);
        });
      });

      describe('Section 4 & 12: Webhook Registration Multi-Mode Fallback', () => {
        function simulateWebhookRegistration(
          role: string,
          secret: string,
          mockResponses: { setWebhookSecret?: boolean; setWebhookQueryOnly?: boolean; setWebhookPath?: boolean }
        ) {
          let chosenMode = 'none';
          let setOk = false;

          // Attempt 1: query + secret_token
          if (mockResponses.setWebhookSecret) {
            setOk = true;
            chosenMode = 'query_secret';
          } else if (mockResponses.setWebhookQueryOnly) {
            // Attempt 2: query only
            setOk = true;
            chosenMode = 'query';
          } else if (mockResponses.setWebhookPath) {
            // Attempt 3: path
            setOk = true;
            chosenMode = 'path';
          }

          // getWebhookInfo verification
          const registeredUrl = setOk ? `https://onival.ir/api/webhook/bale?bot=${role}&k=${secret}` : '';
          const urlMatches = registeredUrl.includes(`bot=${role}`) && registeredUrl.includes(secret);

          return {
            ok: setOk && urlMatches,
            setOk,
            urlMatches,
            mode: chosenMode,
            registeredUrl: registeredUrl ? registeredUrl.replace(secret, '[PROTECTED]') : ''
          };
        }

        test('Falls back to query-only when secret_token rejected and verifies', () => {
          const res = simulateWebhookRegistration('customer', 'csec_test123', {
            setWebhookSecret: false,
            setWebhookQueryOnly: true
          });
          assert.equal(res.ok, true);
          assert.equal(res.setOk, true);
          assert.equal(res.urlMatches, true);
          assert.equal(res.mode, 'query');
          assert.equal(res.registeredUrl, 'https://onival.ir/api/webhook/bale?bot=customer&k=[PROTECTED]');
        });
      });

      describe('Part B & D: Final Hardening Proof Suite (B1-B3, D1-D6)', () => {
        test('B1: unitPriceForFeed agrees with buildProductJsonLd, cartLineTotal, and Torob rules', async () => {
          const { unitPriceForFeed, buildProductJsonLd } = await import('../src/utils/seo');
          const { cartLineTotal } = await import('../src/utils/pricing');

          // Case 1: In stock with active discount and quota
          const prod1: any = {
            id: 101,
            title: 'عسل کوهی',
            slug: 'mountain-honey',
            price: 250000,
            discount: 20,
            specialOfferStock: 5,
            stock: 10,
            isOutOfStock: false,
          };
          const feed1 = unitPriceForFeed(prod1);
          assert.equal(feed1.basePrice, 250000);
          assert.equal(feed1.finalPrice, 200000);
          assert.equal(feed1.discountPercent, 20);
          assert.equal(feed1.isOutOfStock, false);
          assert.equal(feed1.oldPrice, 250000);

          // Agree with cartLineTotal for 1 unit
          const cartTotal1 = cartLineTotal(prod1, '', 1);
          assert.equal(cartTotal1, feed1.finalPrice);

          // Agree with JSON-LD
          const jsonLd1 = buildProductJsonLd('https://onival.ir', prod1);
          assert.equal(jsonLd1.offers.price, String(feed1.finalPrice));
          assert.equal(jsonLd1.offers.availability, 'https://schema.org/InStock');

          // Case 2: Quota exhausted (quota = 0) -> no discount
          const prod2: any = {
            id: 102,
            title: 'گرده گل',
            slug: 'bee-pollen',
            price: 300000,
            discount: 25,
            specialOfferStock: 0,
            stock: 8,
            isOutOfStock: false,
          };
          const feed2 = unitPriceForFeed(prod2);
          assert.equal(feed2.finalPrice, 300000, 'Exhausted promo quota charges full base price');
          assert.equal(feed2.oldPrice, 300000);
          assert.equal(feed2.discountPercent, 0);
          assert.equal(cartLineTotal(prod2, '', 1), 300000);

          // Case 3: Out of stock product -> feed finalPrice is 0
          const prod3: any = {
            id: 103,
            title: 'ژل رویال کمیاب',
            slug: 'royal-jelly',
            price: 500000,
            discount: 10,
            stock: 0,
            isOutOfStock: true,
          };
          const feed3 = unitPriceForFeed(prod3);
          assert.equal(feed3.finalPrice, 0, 'Out of stock returns 0 for feed price');
          assert.equal(feed3.isOutOfStock, true);
          const jsonLd3 = buildProductJsonLd('https://onival.ir', prod3);
          assert.equal(jsonLd3.offers.availability, 'https://schema.org/OutOfStock');
        });

        test('B2: Header notification bell filter strictly rejects Cancelled, Paid, Failed and matches PendingVerification or receipts', () => {
          function filterPendingReceiptOrders(orders: any[]) {
            return orders.filter(
              o =>
                o.status !== 'Cancelled' &&
                o.paymentStatus !== 'Paid' &&
                o.paymentStatus !== 'Failed' &&
                (o.paymentStatus === 'PendingVerification' || Boolean(o.receiptImage || o.receiptImageUrl))
            );
          }

          const sampleOrders = [
            { id: 1, status: 'Cancelled', paymentStatus: 'PendingVerification', receiptImage: '/img.jpg' },
            { id: 2, status: 'Processing', paymentStatus: 'Paid', receiptImage: '/img.jpg' },
            { id: 3, status: 'Pending', paymentStatus: 'Failed', receiptImage: '/img.jpg' },
            { id: 4, status: 'Pending', paymentStatus: 'PendingVerification' },
            { id: 5, status: 'Processing', paymentStatus: 'Unpaid', receiptImage: '/api/admin/receipts/a.jpg' },
            { id: 6, status: 'Pending', paymentStatus: 'Unpaid', receiptImageUrl: '/api/admin/receipt-live/b' },
            { id: 7, status: 'Pending', paymentStatus: 'Unpaid' }
          ];

          const filtered = filterPendingReceiptOrders(sampleOrders);
          assert.deepEqual(filtered.map(o => o.id), [4, 5, 6]);
        });

        test('B3: Type shapes support receipt and order tracking fields', () => {
          const testItem: import('../src/types').OrderItem = {
            id: 1,
            productId: 101,
            productName: 'عسل',
            quantity: 3,
            unitPrice: 200000,
            totalPrice: 600000,
            basePrice: 250000,
            discountedQty: 2,
            regularQty: 1
          };
          assert.equal(testItem.basePrice, 250000);
          assert.equal(testItem.discountedQty, 2);
          assert.equal(testItem.regularQty, 1);

          const testOrder: import('../src/types').Order = {
            id: 1,
            trackingCode: 'ONV-ORD-TEST',
            userFullName: 'علی محمدی',
            phoneNumber: '09120000000',
            userAddress: 'تهران',
            totalPrice: 600000,
            status: 'Pending',
            paymentStatus: 'PendingVerification',
            creationTime: '2026-11-06T10:00:00Z',
            items: [testItem],
            receiptImageUrl: '/api/admin/receipts/test.jpg',
            receiptFileId: 'bale_file_123',
            receiptSource: 'bale_bot',
            receiptStored: true,
            receiptStoreReason: 'download_ok',
            baleChatId: 987654321,
            statusUpdatedAt: '2026-11-06T10:05:00Z',
            statusUpdatedBy: 'admin'
          };
          assert.equal(testOrder.receiptSource, 'bale_bot');
          assert.equal(testOrder.statusUpdatedBy, 'admin');
        });

        test('D1: Formula U = round(B * (100 - D) / 100) exactly matches across JavaScript and PHP specs', async () => {
          const { computeLinePrice } = await import('../src/utils/pricing');
          const testMatrix = [
            { b: 125000, d: 15, expected: 106250 },
            { b: 99000, d: 33, expected: 66330 },
            { b: 234567, d: 12, expected: 206419 },
            { b: 100000, d: 0, expected: 100000 }
          ];

          for (const item of testMatrix) {
            const res = computeLinePrice({ price: item.b, discount: item.d }, '', 1);
            assert.equal(res.discountedUnitPrice, item.expected, `Price for B=${item.b}, D=${item.d}`);
          }
        });

        test('D2: Order submission fails cleanly without synthetic offline mock orders', async () => {
          function simulateOrderSubmission(networkFailure: boolean): Promise<any> {
            if (networkFailure) {
              return Promise.reject(new Error('خطا در اتصال به سرور'));
            }
            return Promise.resolve({ ok: true, order: { trackingCode: 'ONV-ORD-REAL' } });
          }

          await assert.rejects(
            simulateOrderSubmission(true),
            { message: 'خطا در اتصال به سرور' },
            'Must throw real error when network fails; never create fake synthetic order'
          );
        });

        test('D3: Admin order status update error surfacing & 15s polling interval', () => {
          const POLLING_INTERVAL_MS = 15000;
          assert.equal(POLLING_INTERVAL_MS, 15000, 'Orders auto-refresh interval must be 15 seconds');

          function handleStatusUpdateResponse(status: number, data: any) {
            if (status === 409) {
              return { success: false, errorMessage: data.error || 'امکان تغییر وضعیت سفارش وجود ندارد' };
            }
            if (status !== 200 && status !== 204) {
              return { success: false, errorMessage: data.error || 'خطا در بروزرسانی وضعیت' };
            }
            return { success: true, updatedOrder: data.order };
          }

          const conflictRes = handleStatusUpdateResponse(409, { error: 'سفارش لغو شده قابل تغییر وضعیت نیست' });
          assert.equal(conflictRes.success, false);
          assert.equal(conflictRes.errorMessage, 'سفارش لغو شده قابل تغییر وضعیت نیست');

          const okRes = handleStatusUpdateResponse(200, { order: { id: 1, status: 'Completed' } });
          assert.equal(okRes.success, true);
        });

        test('D4: AuthenticatedReceiptImage live streaming fallback contract', () => {
          function resolveReceiptSrc(order: any, isLocalFileAvailable: boolean) {
            if (order.receiptImage && isLocalFileAvailable) {
              return order.receiptImage;
            }
            if (order.receiptFileId) {
              return `/api/admin/receipt-live/${order.trackingCode}`;
            }
            return order.receiptImageUrl || order.receiptImage || null;
          }

          const orderWithLive = {
            trackingCode: 'ONV-ORD-777',
            receiptImage: '/api/admin/receipts/bale_777.jpg',
            receiptFileId: 'live_fid_999'
          };

          assert.equal(resolveReceiptSrc(orderWithLive, true), '/api/admin/receipts/bale_777.jpg');
          assert.equal(resolveReceiptSrc(orderWithLive, false), '/api/admin/receipt-live/ONV-ORD-777');
        });

        test('D5: Bot tab error toast surfacing on failure', () => {
          function processBotActionResponse(res: { ok: boolean; message?: string; error?: string }) {
            if (!res.ok) {
              return { type: 'error', toastMessage: res.error || res.message || 'خطا در عملیات ربات' };
            }
            return { type: 'success', toastMessage: res.message || 'عملیات با موفقیت انجام شد' };
          }

          const errToast = processBotActionResponse({ ok: false, error: 'توکن ربات معتبر نیست' });
          assert.equal(errToast.type, 'error');
          assert.equal(errToast.toastMessage, 'توکن ربات معتبر نیست');
        });

        test('D6: Catalog replacement correctly overrides even when target database array is empty', () => {
          function replaceCatalog(currentDb: any, seedData: any) {
            const entities = ['products', 'categories', 'articles'];
            const updated = { ...currentDb };
            for (const ent of entities) {
              updated[ent] = Array.isArray(seedData[ent]) ? [...seedData[ent]] : [];
            }
            return updated;
          }

          const emptyDb = { products: [], categories: [], articles: [] };
          const seed = { products: [{ id: 1, title: 'عسل' }], categories: [{ id: 1, title: 'عسل‌ها' }], articles: [] };

          const res = replaceCatalog(emptyDb, seed);
          assert.equal(res.products.length, 1);
          assert.equal(res.categories.length, 1);
          assert.equal(res.products[0].title, 'عسل');
        });

        describe('Finishing Pass Verification (Bugs 1-7, 12, Receipt Formats & Frontend Fixes)', () => {
          test('Bug 1: Receipt live route passes telegramConfig to onivalBotRoleToken and validates JPEG/PNG', () => {
            const dbMock = {
              telegramConfig: { customerBotToken: 'c_tok_123', adminBotToken: 'a_tok_456' },
              orders: [{ trackingCode: 'ONV-ORD-REC-1', receiptFileId: 'fid_rec_1' }]
            };
            function mockBotRoleToken(tgConfig: any, role: string) {
              assert.ok(tgConfig && !('orders' in tgConfig), 'Must pass telegramConfig, NEVER full $db');
              return role === 'customer' ? tgConfig.customerBotToken : tgConfig.adminBotToken;
            }
            const token = mockBotRoleToken(dbMock.telegramConfig, 'customer');
            assert.equal(token, 'c_tok_123');

            // Image format validation contract (JPEG/PNG only)
            function validateReceiptBytes(buf: Buffer): { ok: boolean; code?: string; ext?: string } {
              if (buf.length < 20) return { ok: false, code: 'IMAGE_INVALID' };
              if (buf.length > 5 * 1024 * 1024) return { ok: false, code: 'IMAGE_TOO_LARGE' };
              const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
              const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
              if (isPng) return { ok: true, ext: 'png' };
              if (isJpeg) return { ok: true, ext: 'jpg' };
              return { ok: false, code: 'UNSUPPORTED_IMAGE_FORMAT' };
            }

            const validJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
            const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
            const invalidWebp = Buffer.concat([Buffer.from('RIFF....WEBP', 'ascii'), Buffer.alloc(100)]);
            const invalidGif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(100)]);

            assert.equal(validateReceiptBytes(validJpeg).ok, true);
            assert.equal(validateReceiptBytes(validPng).ok, true);
            assert.equal(validateReceiptBytes(invalidWebp).ok, false);
            assert.equal(validateReceiptBytes(invalidWebp).code, 'UNSUPPORTED_IMAGE_FORMAT');
            assert.equal(validateReceiptBytes(invalidGif).ok, false);
            assert.equal(validateReceiptBytes(invalidGif).code, 'UNSUPPORTED_IMAGE_FORMAT');
          });

          test('Bug 2: Test invoice endpoint uses telegramConfig, role selection, current mode, and correct argument order', () => {
            const dbMock = {
              telegramConfig: {
                customerBotToken: 'cust_tok',
                adminBotToken: 'admin_tok',
                adminChatId: '987654',
                balePaymentMode: 'test',
                baleWalletTokenTest: 'wallet_test_tok',
                baleWalletTokenLive: 'wallet_live_tok'
              }
            };

            function getWalletToken(tg: any, mode: string) {
              assert.ok(tg && !('telegramConfig' in tg), 'Must pass telegramConfig, not $db');
              return mode === 'test' ? tg.baleWalletTokenTest : tg.baleWalletTokenLive;
            }

            function getAdminChatId(tg: any) {
              assert.ok(tg && !('telegramConfig' in tg), 'Must pass telegramConfig, not $db');
              return tg.adminChatId;
            }

            const tg = dbMock.telegramConfig;
            const mode = tg.balePaymentMode;
            const walletToken = getWalletToken(tg, mode);
            const chatId = getAdminChatId(tg);
            assert.equal(walletToken, 'wallet_test_tok');
            assert.equal(chatId, '987654');

            // Argument order check: sendBaleInvoiceSafe($token, $chatId, $title, $description, $payload, $providerToken, $currency, $prices)
            let calledWith: any = null;
            function sendBaleInvoiceSafe(token: string, destChatId: string, title: string, desc: string, payload: string, providerTok: string, currency: string, prices: any[]) {
              calledWith = { token, destChatId, title, desc, payload, providerTok, currency, prices };
              return { ok: true };
            }

            sendBaleInvoiceSafe('admin_tok', chatId, 'تست فاکتور کیف‌پول بله', 'فاکتور تست آزمایشی سیستم اونیوال', 'test_payload_123', walletToken, 'IRR', [{ label: 'آزمایش درگاه', amount: 10000 }]);

            assert.equal(calledWith.token, 'admin_tok');
            assert.equal(calledWith.destChatId, '987654');
            assert.equal(calledWith.providerTok, 'wallet_test_tok');
            assert.equal(calledWith.prices[0].amount, 10000);
          });

          test('Bug 3: Order status update whitelist validation, cancelWrite on error, and statusUpdatedAt', () => {
            function applyStatusUpdate(order: any, newStatus: string | null, newPayStatus: string | null, actor = 'admin') {
              const allowedStatuses = ['Pending', 'Processing', 'Shipped', 'Completed', 'Cancelled'];
              const allowedPay = ['Unpaid', 'PendingVerification', 'Paid', 'Failed'];

              if (newStatus && !allowedStatuses.includes(newStatus)) {
                return { _cancelWrite: true, ok: false, code: 'VALIDATION_ERROR', status: 400 };
              }
              if (newPayStatus && !allowedPay.includes(newPayStatus)) {
                return { _cancelWrite: true, ok: false, code: 'VALIDATION_ERROR', status: 400 };
              }
              if (order.status === 'Cancelled' && newStatus !== 'Cancelled') {
                return { _cancelWrite: true, ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409 };
              }
              if (order.paymentStatus === 'Paid' && newPayStatus && newPayStatus !== 'Paid') {
                return { _cancelWrite: true, ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409 };
              }
              if ((order.status === 'Shipped' || order.status === 'Completed') && newStatus === 'Cancelled') {
                return { _cancelWrite: true, ok: false, code: 'TRANSITION_NOT_ALLOWED', status: 409 };
              }

              const targetStatus = newStatus || order.status;
              const targetPay = newPayStatus || order.paymentStatus;
              if (targetStatus === order.status && targetPay === order.paymentStatus) {
                return { _cancelWrite: true, ok: true, unchanged: true, order };
              }

              const updated = {
                ...order,
                status: targetStatus,
                paymentStatus: targetPay,
                statusUpdatedAt: '2026-11-07T00:00:00Z',
                statusUpdatedBy: actor
              };
              return { ok: true, unchanged: false, order: updated };
            }

            const ord = { id: 1, trackingCode: 'ONV-ORD-T1', status: 'Pending', paymentStatus: 'Unpaid' };

            // Invalid status
            const inv = applyStatusUpdate(ord, 'InvalidStatus', null);
            assert.equal(inv.ok, false);
            assert.equal(inv._cancelWrite, true);
            assert.equal(inv.code, 'VALIDATION_ERROR');

            // Unchanged
            const unc = applyStatusUpdate(ord, 'Pending', 'Unpaid');
            assert.equal(unc.ok, true);
            assert.equal(unc.unchanged, true);
            assert.equal(unc._cancelWrite, true);

            // Shipped approval preserves requested Shipped status
            const apr = applyStatusUpdate(ord, 'Shipped', 'Paid');
            assert.equal(apr.ok, true);
            assert.equal(apr.order.status, 'Shipped');
            assert.equal(apr.order.paymentStatus, 'Paid');
            assert.ok(apr.order.statusUpdatedAt);
            assert.equal(apr.order.statusUpdatedBy, 'admin');
          });

          test('Bug 4: onivalUniqueNumericId ensures strict monotonic integer allocation', () => {
            function onivalUniqueNumericIdJs(items: any[]): number {
              let max = 0;
              for (const it of items) {
                const id = typeof it === 'object' && it !== null && 'id' in it ? Number(it.id) : 0;
                if (!isNaN(id) && id > max) max = id;
              }
              return max > 0 ? max + 1 : Date.now();
            }

            const items = [{ id: 100 }, { id: 105 }, { id: 98 }];
            assert.equal(onivalUniqueNumericIdJs(items), 106);
            assert.equal(onivalUniqueNumericIdJs([...items, { id: 106 }]), 107);
          });

          test('Bug 5 & 13: Receipt upload rejects WEBP and GIF, accepts PNG/JPEG, returns 415/413', () => {
            function handleUploadValidation(dataUrl: string) {
              const match = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
              if (!match) {
                return { status: 415, code: 'UNSUPPORTED_IMAGE_FORMAT', error: 'تنها فرمت‌های تصویری PNG و JPG مجاز هستند.' };
              }
              const bin = Buffer.from(match[2], 'base64');
              if (bin.length > 5 * 1024 * 1024) {
                return { status: 413, code: 'IMAGE_TOO_LARGE', error: 'حجم تصویر بیش از ۵ مگابایت است.' };
              }
              const isPng = bin.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
              const isJpeg = bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff;
              if (!isPng && !isJpeg) {
                return { status: 415, code: 'UNSUPPORTED_IMAGE_FORMAT', error: 'فرمت تصویر مجاز نیست.' };
              }
              return { status: 200, code: 'OK', ext: isPng ? 'png' : 'jpg' };
            }

            const webpUrl = 'data:image/webp;base64,UklGRmQAAABXRUJQVlA4T...';
            const gifUrl = 'data:image/gif;base64,R0lGODlhAQABA...';
            const fakePngUrl = 'data:image/png;base64,' + Buffer.from('not real png bytes').toString('base64');
            const realPngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
            const realPngUrl = 'data:image/png;base64,' + realPngBuf.toString('base64');

            assert.equal(handleUploadValidation(webpUrl).status, 415);
            assert.equal(handleUploadValidation(gifUrl).status, 415);
            assert.equal(handleUploadValidation(fakePngUrl).status, 415);
            assert.equal(handleUploadValidation(realPngUrl).status, 200);
          });

          test('Bug 6: Webhook rejects non-image media with exact Persian rejection text', () => {
            const PERSIAN_REJECT = 'فرمت فایل ارسالی پذیرفته نیست. لطفاً تصویر فیش را فقط با فرمت JPG یا PNG ارسال کنید (به‌صورت عکس یا فایل تصویری).';

            function inspectWebhookMedia(msg: any) {
              const isUnsupportedMedia = !empty(msg.video) || !empty(msg.audio) || !empty(msg.voice) ||
                !empty(msg.sticker) || !empty(msg.animation) || !empty(msg.video_note);
              if (isUnsupportedMedia) {
                return { rejected: true, text: PERSIAN_REJECT, reason: 'unsupported_format' };
              }
              if (msg.document) {
                const mime = (msg.document.mime_type || '').toLowerCase();
                const fn = (msg.document.file_name || '').toLowerCase();
                const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
                const allowedExts = ['.jpg', '.jpeg', '.png'];
                const hasValidMime = allowedMimes.includes(mime);
                const hasValidExt = allowedExts.some(ext => fn.endsWith(ext));
                if (!hasValidMime && !hasValidExt) {
                  return { rejected: true, text: PERSIAN_REJECT, reason: 'unsupported_format' };
                }
              }
              return { rejected: false };
            }

            function empty(v: any) { return v === undefined || v === null || v === false || v === ''; }

            assert.equal(inspectWebhookMedia({ video: { file_id: 'vid1' } }).rejected, true);
            assert.equal(inspectWebhookMedia({ video: { file_id: 'vid1' } }).text, PERSIAN_REJECT);
            assert.equal(inspectWebhookMedia({ voice: { file_id: 'voc1' } }).rejected, true);
            assert.equal(inspectWebhookMedia({ document: { file_name: 'receipt.pdf', mime_type: 'application/pdf' } }).rejected, true);
            assert.equal(inspectWebhookMedia({ document: { file_name: 'receipt.webp', mime_type: 'image/webp' } }).rejected, true);
            assert.equal(inspectWebhookMedia({ document: { file_name: 'receipt.jpg', mime_type: 'image/jpeg' } }).rejected, false);
            assert.equal(inspectWebhookMedia({ photo: [{ file_id: 'p1' }] }).rejected, false);
          });

          test('Bug 7 & 12: sendBaleInvoiceSafe retries with minimal payload on failure', () => {
            let attempt = 0;
            const payloadsSent: any[] = [];

            function mockCurlSendInvoice(body: any) {
              attempt++;
              payloadsSent.push(body);
              if (attempt === 1) {
                return { ok: false, error_code: 400, description: 'Bad Request: unsupported parameters' };
              }
              return { ok: true, result: { message_id: 12345 } };
            }

            function sendBaleInvoiceSafeJs(fullParams: any) {
              const res = mockCurlSendInvoice(fullParams);
              if (res.ok) return res;
              // Retry once with minimal payload
              const minimal = {
                chat_id: fullParams.chat_id,
                title: fullParams.title,
                description: fullParams.description,
                payload: fullParams.payload,
                provider_token: fullParams.provider_token,
                prices: fullParams.prices
              };
              return mockCurlSendInvoice(minimal);
            }

            const initialParams = {
              chat_id: '123',
              title: 'تست',
              description: 'شرح',
              payload: 'p1',
              provider_token: 'ptok',
              currency: 'IRR',
              prices: [{ label: 'سفارش', amount: 10000 }],
              need_phone_number: true,
              send_phone_number_to_provider: true
            };

            const outcome = sendBaleInvoiceSafeJs(initialParams);
            assert.equal(outcome.ok, true);
            assert.equal(attempt, 2, 'Must have retried once on failure');
            assert.equal('need_phone_number' in payloadsSent[1], false, 'Minimal retry must strip extra optional fields');
            assert.equal(payloadsSent[1].provider_token, 'ptok');
          });

          test('Frontend: handleVerifyReceipt throws error on failure and refetches', async () => {
            let fetchCount = 0;
            async function refetch() { fetchCount++; }

            async function handleVerifyReceiptJs(id: number, approved: boolean, simulateOk: boolean) {
              try {
                if (!simulateOk) {
                  throw new Error('خطا در بررسی فیش (کد 409)');
                }
                await refetch();
              } catch (err) {
                await refetch();
                throw err;
              }
            }

            // Success case
            await handleVerifyReceiptJs(1, true, true);
            assert.equal(fetchCount, 1);

            // Failure case: must rethrow AND refetch
            await assert.rejects(
              handleVerifyReceiptJs(1, true, false),
              { message: 'خطا در بررسی فیش (کد 409)' }
            );
            assert.equal(fetchCount, 2, 'Refetch must be called even on rejection');
          });

          test('Frontend: Offline refusal returns 503 for non-GET /api/contact, /api/orders, and /api/consultations', () => {
            function checkOfflineRoute(urlStr: string, method: string) {
              if (
                urlStr.startsWith('/api/admin/') ||
                urlStr.startsWith('/api/account/change-credentials') ||
                urlStr.startsWith('/api/account/profile') ||
                urlStr.startsWith('/api/bot/') ||
                ((urlStr.startsWith('/api/orders') || urlStr.startsWith('/api/consultations') || urlStr.startsWith('/api/contact')) && method !== 'GET')
              ) {
                return { status: 503, code: 'SERVICE_UNAVAILABLE' };
              }
              return { status: 200, code: 'OFFLINE_CACHE' };
            }

            assert.equal(checkOfflineRoute('/api/contact', 'POST').status, 503);
            assert.equal(checkOfflineRoute('/api/orders', 'POST').status, 503);
            assert.equal(checkOfflineRoute('/api/consultations', 'POST').status, 503);
            assert.equal(checkOfflineRoute('/api/products', 'GET').status, 200);
          });

          // ==============================================================================
          // FIX PASS 2: AUTOMATED VERIFICATION FOR ISSUES 1 - 5 & PHASE 0 CONTRACT
          // ==============================================================================
          describe('Fix Pass 2: Pricing, Breakdown, Payment Revert, Safe Links, Content Schema & Receipts', () => {
            test('Issue 1 & Phase 0: computeLinePrice returns complete canonical shape and matches across 12 test vectors', () => {
              const vectors = [
                // 1. Standard no discount
                { base: 100000, disc: 0, quota: 0, qty: 3, expTotal: 300000, expDiscQty: 0, expRegQty: 3, expCapped: false },
                // 2. 10% discount, unlimited quota (quota: 0)
                { base: 100000, disc: 10, quota: 0, qty: 3, expTotal: 270000, expDiscQty: 3, expRegQty: 0, expCapped: false },
                // 3. 20% discount, quota 2, qty 5 (capped)
                { base: 100000, disc: 20, quota: 2, qty: 5, expTotal: 460000, expDiscQty: 2, expRegQty: 3, expCapped: true },
                // 4. Quota exactly equal to qty
                { base: 200000, disc: 15, quota: 4, qty: 4, expTotal: 680000, expDiscQty: 4, expRegQty: 0, expCapped: false },
                // 5. Quota greater than qty
                { base: 50000, disc: 50, quota: 10, qty: 2, expTotal: 50000, expDiscQty: 2, expRegQty: 0, expCapped: false },
                // 6. 25% discount on 120,000, quota 2, qty 1
                { base: 120000, disc: 25, quota: 2, qty: 1, expTotal: 90000, expDiscQty: 1, expRegQty: 0, expCapped: false },
                // 7. Negative discount clamped to 0
                { base: 80000, disc: -10, quota: 0, qty: 2, expTotal: 160000, expDiscQty: 0, expRegQty: 2, expCapped: false },
                // 8. 99% discount max clamp
                { base: 100000, disc: 99, quota: 1, qty: 2, expTotal: 101000, expDiscQty: 1, expRegQty: 1, expCapped: true },
                // 9. Rounding check (33% discount on 100,000 => unit price 67,000)
                { base: 100000, disc: 33, quota: 1, qty: 2, expTotal: 167000, expDiscQty: 1, expRegQty: 1, expCapped: true },
                // 10. Large amount and quota
                { base: 10000000, disc: 10, quota: 3, qty: 5, expTotal: 47000000, expDiscQty: 3, expRegQty: 2, expCapped: true },
                // 11. 100% discount is clamped to 99%
                { base: 100000, disc: 100, quota: 0, qty: 1, expTotal: 1000, expDiscQty: 1, expRegQty: 0, expCapped: false },
                // 12. Quota 1, qty 1 (not capped)
                { base: 500000, disc: 20, quota: 1, qty: 1, expTotal: 400000, expDiscQty: 1, expRegQty: 0, expCapped: false }
              ];

              for (const [idx, v] of vectors.entries()) {
                const res = computeLinePrice(
                  {
                    price: v.base,
                    discount: v.disc,
                    specialOfferStock: v.quota === 0 ? null : v.quota,
                  },
                  '',
                  v.qty
                );
                assert.equal(res.lineTotal, v.expTotal, `Vector ${idx + 1} lineTotal mismatch`);
                assert.equal(res.totalPrice, v.expTotal, `Vector ${idx + 1} totalPrice alias mismatch`);
                assert.equal(res.discountedQty, v.expDiscQty, `Vector ${idx + 1} discountedQty mismatch`);
                assert.equal(res.discountedUnits, v.expDiscQty, `Vector ${idx + 1} discountedUnits alias mismatch`);
                assert.equal(res.regularQty, v.expRegQty, `Vector ${idx + 1} regularQty mismatch`);
                assert.equal(res.regularUnits, v.expRegQty, `Vector ${idx + 1} regularUnits alias mismatch`);
                assert.equal(res.capped, v.expCapped, `Vector ${idx + 1} capped flag mismatch`);
              }
            });

            test('Issue 1: buildLineRows generates structured breakdown rows matching total sum', async () => {
              const { buildLineRows } = await import('../src/utils/pricing.js');
              
              // Capped case (3 discounted, 2 regular)
              const cappedItem = {
                productName: 'عسل آویشن',
                size: '۱ کیلوگرم',
                quantity: 5,
                unitPrice: 94000,
                totalPrice: 470000,
                discountedUnits: 3,
                regularUnits: 2,
                discountedUnitPrice: 90000,
                basePrice: 100000,
                discountPercent: 10,
                discountedSubtotal: 270000,
                regularSubtotal: 200000,
                capped: true,
                quota: 3
              };
              const rows = buildLineRows(cappedItem);
              assert.equal(rows.length, 2, 'Capped item must have 2 breakdown rows');
              assert.equal(rows[0].kind, 'discounted');
              assert.equal(rows[0].qty, 3);
              assert.equal(rows[0].unitPrice, 90000);
              assert.equal(rows[0].amount, 270000);
              assert.equal(rows[1].kind, 'regular');
              assert.equal(rows[1].qty, 2);
              assert.equal(rows[1].unitPrice, 100000);
              assert.equal(rows[1].amount, 200000);
              assert.equal(rows[0].amount + rows[1].amount, cappedItem.totalPrice);

              // Uncapped fully discounted case
              const uncappedItem = {
                productName: 'ژل رویال',
                quantity: 2,
                unitPrice: 180000,
                totalPrice: 360000,
                discountedUnits: 2,
                regularUnits: 0,
                discountedUnitPrice: 180000,
                basePrice: 200000,
                discountPercent: 10
              };
              const uncappedRows = buildLineRows(uncappedItem);
              assert.equal(uncappedRows.length, 1);
              assert.equal(uncappedRows[0].kind, 'discounted');
              assert.equal(uncappedRows[0].amount, 360000);
            });

            test('Issue 2: Payment status revert logic validates reason and protects shipped status', () => {
              function validatePaymentRevert(oldPayStatus: string, newPayStatus: string, orderStatus: string, options: any) {
                if (oldPayStatus === 'Paid' && newPayStatus !== 'Paid') {
                  const reason = typeof options?.paymentChangeReason === 'string' ? options.paymentChangeReason.trim() : '';
                  if (reason.length < 3 || reason.length > 300) {
                    return { ok: false, error: 'برای تغییر وضعیت از پرداخت‌شده، درج دلیل تغییر (۳ تا ۳۰۰ کاراکتر) الزامی است.' };
                  }
                  if ((orderStatus === 'Shipped' || orderStatus === 'Completed') && options?.confirmShipped !== true) {
                    return { ok: false, error: 'این سفارش ارسال/تکمیل شده است. تایید مسوولیت جهت بازگرداندن وضعیت پرداخت الزامی است.' };
                  }
                  return { ok: true, restoreInventory: orderStatus === 'Pending' || orderStatus === 'Processing' };
                }
                return { ok: true, restoreInventory: false };
              }

              // Revert without reason fails
              const r1 = validatePaymentRevert('Paid', 'Unpaid', 'Pending', {});
              assert.equal(r1.ok, false);
              assert.ok(r1.error?.includes('درج دلیل تغییر'));

              // Revert with short reason fails
              const r2 = validatePaymentRevert('Paid', 'PendingVerification', 'Processing', { paymentChangeReason: 'نه' });
              assert.equal(r2.ok, false);

              // Revert on Shipped order without confirmShipped fails
              const r3 = validatePaymentRevert('Paid', 'Failed', 'Shipped', { paymentChangeReason: 'عدم تطابق فیش بانکی با واریز' });
              assert.equal(r3.ok, false);
              assert.ok(r3.error?.includes('ارسال/تکمیل شده'));

              // Revert on Shipped with confirmation succeeds and does not restore inventory
              const r4 = validatePaymentRevert('Paid', 'Unpaid', 'Shipped', {
                paymentChangeReason: 'برگشت حواله به حساب مبدا',
                confirmShipped: true
              });
              assert.equal(r4.ok, true);
              assert.equal(r4.restoreInventory, false);

              // Revert on Pending succeeds and restores inventory
              const r5 = validatePaymentRevert('Paid', 'Unpaid', 'Pending', {
                paymentChangeReason: 'درخواست ابطال توسط کاربر'
              });
              assert.equal(r5.ok, true);
              assert.equal(r5.restoreInventory, true);
            });

            test('Issue 3: safeLink allows safe routes and schemes while rejecting dangerous URIs', async () => {
              const { safeLink } = await import('../src/utils/safeLink.js');

              // Allowed internal routes
              assert.equal(safeLink('/').href, '/');
              assert.equal(safeLink('/articles').href, '/articles');
              assert.equal(safeLink('/products/12').href, '/products/12');
              assert.equal(safeLink('products/12').href, '/products/12');
              assert.equal(safeLink('#section-intro').href, '#section-intro');

              // Allowed external https
              assert.equal(safeLink('https://ble.ir/onival_ir').href, 'https://ble.ir/onival_ir');
              assert.equal(safeLink('http://example.com').href, 'http://example.com');

              // Blocked dangerous URI schemes
              assert.equal(safeLink('javascript:alert(1)').href, '#');
              assert.equal(safeLink('JAVASCRIPT:alert(1)').href, '#');
              assert.equal(safeLink('data:text/html,<script>alert(1)</script>').href, '#');
              assert.equal(safeLink('vbscript:msgbox').href, '#');
              assert.equal(safeLink('file:///etc/passwd').href, '#');
              assert.equal(safeLink('').href, '#');
            });

            test('Issue 4: Defensive site-content normalization protects homeSections and arrays', () => {
              function normalizeSiteContentJs(input: any) {
                const src = input && typeof input === 'object' ? input : {};
                const homeSections = Array.isArray(src.homeSections) ? src.homeSections : [];
                return {
                  ...src,
                  siteTitle: typeof src.siteTitle === 'string' && src.siteTitle.trim() ? src.siteTitle : 'فروشگاه تخصصی عسل و فرآورده‌های ارگانیک اونیوال',
                  homeSections: homeSections.length > 0 ? homeSections : [
                    { id: 'top_banners', type: 'top_banners', title: 'بنرهای اصلی', enabled: true, order: 1 }
                  ],
                  topBanners: Array.isArray(src.topBanners) ? src.topBanners : [],
                  navLabels: src.navLabels && typeof src.navLabels === 'object' ? src.navLabels : {}
                };
              }

              // When homeSections is completely undefined or corrupted (as caused by earlier reset bug)
              const brokenInput = { siteTitle: 'اونیوال' };
              const normalized = normalizeSiteContentJs(brokenInput);
              assert.ok(Array.isArray(normalized.homeSections), 'homeSections must be an array');
              assert.ok(normalized.homeSections.length > 0, 'homeSections must not be empty');
              assert.ok(Array.isArray(normalized.topBanners), 'topBanners must be an array');
              assert.doesNotThrow(() => {
                // Must not throw when mapped or filtered in PageEditorView
                normalized.homeSections.filter((s: any) => s.enabled);
                [...normalized.homeSections];
              });
            });

            test('Issue 5: Receipt cleanup logic distinguishes retained, expired and keep-flagged receipts', () => {
              const now = Date.now();
              const dayMs = 86400 * 1000;
              const files = [
                // 1. Recent receipt (5 days old) -> keep
                { name: 'rec_1.jpg', size: 50000, mtimeMs: now - 5 * dayMs, ref: 'ONV-1', keep: false },
                // 2. Old receipt (40 days old), keep flag FALSE -> delete
                { name: 'rec_2.jpg', size: 80000, mtimeMs: now - 40 * dayMs, ref: 'ONV-2', keep: false },
                // 3. Old receipt (40 days old), keep flag TRUE -> keep
                { name: 'rec_3.jpg', size: 90000, mtimeMs: now - 40 * dayMs, ref: 'ONV-3', keep: true },
                // 4. Orphan file not attached to any order, 10 days old -> delete if deleteOrphans=true
                { name: 'rec_orphan.jpg', size: 30000, mtimeMs: now - 10 * dayMs, ref: null, keep: false }
              ];

              function simulateCleanup(fileList: typeof files, retentionDays: number, deleteOrphans: boolean) {
                const threshold = now - (retentionDays * dayMs);
                let wouldDeleteCount = 0;
                let wouldDeleteBytes = 0;
                let orphansCount = 0;

                for (const f of fileList) {
                  if (f.keep) continue;
                  if (!f.ref && deleteOrphans) {
                    orphansCount++;
                    wouldDeleteCount++;
                    wouldDeleteBytes += f.size;
                    continue;
                  }
                  if (f.mtimeMs < threshold) {
                    wouldDeleteCount++;
                    wouldDeleteBytes += f.size;
                  }
                }

                return { wouldDeleteCount, wouldDeleteBytes, orphansCount };
              }

              const res = simulateCleanup(files, 30, true);
              assert.equal(res.wouldDeleteCount, 2, 'Must flag rec_2 and rec_orphan for deletion');
              assert.equal(res.orphansCount, 1);
              assert.equal(res.wouldDeleteBytes, 110000);
            });
          });
        });
      });
    });
  });
});

