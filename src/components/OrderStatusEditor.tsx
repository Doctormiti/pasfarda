import React, { useState, useEffect } from 'react';
import { Order } from '../types';
import { Check, Loader2, AlertTriangle, RotateCcw, Save } from 'lucide-react';

interface OrderStatusEditorProps {
  order: Order;
  onSave: (
    id: number | string,
    status: Order['status'],
    paymentStatus?: Order['paymentStatus'],
    options?: { paymentChangeReason?: string; confirmShipped?: boolean }
  ) => Promise<any>;
}

export const OrderStatusEditor: React.FC<OrderStatusEditorProps> = ({ order, onSave }) => {
  const [draftStatus, setDraftStatus] = useState<Order['status']>(order.status);
  const [draftPaymentStatus, setDraftPaymentStatus] = useState<Order['paymentStatus']>(order.paymentStatus);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Revert payment modal state
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertReason, setRevertReason] = useState('');
  const [confirmShipped, setConfirmShipped] = useState(false);
  const [targetRevertPaymentStatus, setTargetRevertPaymentStatus] = useState<Order['paymentStatus']>('Unpaid');

  // Sync draft if order changes externally and we are not dirty or saving
  useEffect(() => {
    if (!isSaving && draftStatus === order.status && draftPaymentStatus === order.paymentStatus) {
      setDraftStatus(order.status);
      setDraftPaymentStatus(order.paymentStatus);
    }
  }, [order.status, order.paymentStatus, isSaving]);

  const isDirty = draftStatus !== order.status || draftPaymentStatus !== order.paymentStatus;
  const isOrderShippedOrCompleted = order.status === 'Shipped' || order.status === 'Completed';

  const handlePaymentSelectChange = (newVal: Order['paymentStatus']) => {
    setError(null);
    if (order.paymentStatus === 'Paid' && newVal !== 'Paid') {
      // Trigger modal for reason & confirm
      setTargetRevertPaymentStatus(newVal);
      setRevertReason('');
      setConfirmShipped(false);
      setShowRevertModal(true);
    } else {
      setDraftPaymentStatus(newVal);
    }
  };

  const handleStatusSelectChange = (newVal: Order['status']) => {
    setError(null);
    setDraftStatus(newVal);
  };

  const handleCancel = () => {
    setDraftStatus(order.status);
    setDraftPaymentStatus(order.paymentStatus);
    setError(null);
  };

  const handleSave = async (options?: { paymentChangeReason?: string; confirmShipped?: boolean }) => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await onSave(order.id, draftStatus, draftPaymentStatus, options);
      setSuccess('تغییرات با موفقیت ذخیره شد');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err?.message || 'خطا در ذخیره وضعیت سفارش');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmRevert = async () => {
    const trimmed = revertReason.trim();
    if (trimmed.length < 3) {
      setError('علت تغییر وضعیت پرداخت الزامی است (حداقل ۳ کاراکتر).');
      return;
    }
    if (isOrderShippedOrCompleted && !confirmShipped) {
      setError('برای سفارشات ارسال‌شده یا تکمیل‌شده، تاییدیه خروج مرسوله از انبار الزامی است.');
      return;
    }

    setDraftPaymentStatus(targetRevertPaymentStatus);
    setShowRevertModal(false);

    // Immediately trigger save with the required options
    setIsSaving(true);
    setError(null);
    try {
      await onSave(order.id, draftStatus, targetRevertPaymentStatus, {
        paymentChangeReason: trimmed,
        confirmShipped,
      });
      setSuccess('بازگشت وضعیت پرداخت با موفقیت ثبت شد');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err?.message || 'خطا در ثبت بازگشت وضعیت پرداخت');
      // Revert draft back on server error
      setDraftPaymentStatus(order.paymentStatus);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draftPaymentStatus}
          disabled={isSaving}
          onChange={(e) => handlePaymentSelectChange(e.target.value as Order['paymentStatus'])}
          className={`px-3 py-1.5 border rounded-xl text-xs font-bold transition focus:outline-hidden ${
            draftPaymentStatus !== order.paymentStatus
              ? 'border-amber-400 bg-amber-50 text-amber-900 ring-2 ring-amber-300/40'
              : 'border-slate-200 bg-slate-50 text-slate-700'
          }`}
          title="وضعیت پرداخت فاکتور"
        >
          <option value="Unpaid">پرداخت نشده</option>
          <option value="PendingVerification">فیش منتظر تایید</option>
          <option value="Paid">پرداخت تایید شده</option>
          <option value="Failed">پرداخت ناموفق / رد شده</option>
        </select>

        <select
          value={draftStatus}
          disabled={isSaving}
          onChange={(e) => handleStatusSelectChange(e.target.value as Order['status'])}
          className={`px-3 py-1.5 border rounded-xl text-xs font-bold transition focus:outline-hidden ${
            draftStatus !== order.status
              ? 'border-blue-400 bg-blue-50 text-blue-900 ring-2 ring-blue-300/40'
              : 'border-slate-200 bg-white text-slate-800'
          }`}
          title="وضعیت پردازش و ارسال سفارش"
        >
          <option value="Pending">در انتظار بررسی</option>
          <option value="Processing">در حال آماده‌سازی</option>
          <option value="Shipped">ارسال شده</option>
          <option value="Completed">تکمیل شده</option>
          <option value="Cancelled">لغو سفارش</option>
        </select>

        {isDirty && !isSaving && (
          <div className="flex items-center gap-1.5 animate-fadeIn">
            <button
              type="button"
              onClick={() => handleSave()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition cursor-pointer"
              title="ذخیره تغییرات وضعیت"
            >
              <Save className="w-3.5 h-3.5" />
              <span>ذخیره تغییرات</span>
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="p-1.5 rounded-xl text-slate-500 hover:bg-slate-100 transition cursor-pointer"
              title="انصراف"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {isSaving && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" />
            <span>در حال ذخیره...</span>
          </div>
        )}

        {success && !isDirty && (
          <div className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600 animate-fadeIn">
            <Check className="w-3.5 h-3.5" />
            <span>{success}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-medium animate-fadeIn">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Modal for Reverting Paid Status */}
      {showRevertModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4 animate-scaleUp text-right"
            dir="rtl"
          >
            <div className="flex items-center gap-2 text-amber-600 border-b border-slate-100 pb-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-black text-slate-900">
                بازگشت از وضعیت پرداخت تایید شده
              </h3>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              این سفارش قبلاً به عنوان «پرداخت تایید شده» ثبت گردیده است. برای تغییر وضعیت به{' '}
              <strong className="text-slate-900">
                {targetRevertPaymentStatus === 'Unpaid'
                  ? 'پرداخت نشده'
                  : targetRevertPaymentStatus === 'PendingVerification'
                  ? 'فیش منتظر تایید'
                  : 'ناموفق'}
              </strong>
              ، ثبت علت الزامی است:
            </p>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                علت بازگشت وضعیت پرداخت (حداقل ۳ کاراکتر):
              </label>
              <textarea
                rows={3}
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                placeholder="مثلاً: خطای اپراتور در ثبت تایید فیش واریزی..."
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-amber-500 font-medium"
              />
            </div>

            {isOrderShippedOrCompleted && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 space-y-2">
                <p className="text-[11px] text-amber-900 leading-relaxed">
                  ⚠️ سفارش در وضعیت <strong>«{order.status === 'Shipped' ? 'ارسال شده' : 'تکمیل شده'}»</strong> است و مرسوله از انبار خارج گردیده است. با تایید این بخش، موجودی کالا به انبار بازگردانده نخواهد شد.
                </p>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={confirmShipped}
                    onChange={(e) => setConfirmShipped(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 border-slate-300"
                  />
                  <span className="text-xs font-bold text-amber-950">
                    تاییدیه خروج مرسوله از انبار
                  </span>
                </label>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowRevertModal(false);
                  setDraftPaymentStatus(order.paymentStatus);
                }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 transition cursor-pointer"
              >
                انصراف
              </button>
              <button
                type="button"
                onClick={handleConfirmRevert}
                disabled={revertReason.trim().length < 3 || (isOrderShippedOrCompleted && !confirmShipped)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white shadow-xs transition cursor-pointer"
              >
                تایید و بازگشت وضعیت پرداخت
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
