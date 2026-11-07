import React from 'react';
import { buildLineRows } from '../utils/pricing';
import { Sparkles, Info } from 'lucide-react';

interface PriceBreakdownProps {
  item: any;
  showCappedNote?: boolean;
  className?: string;
  compact?: boolean;
}

export const formatPersianNumber = (num: number | string): string => {
  const parts = Number(num || 0).toLocaleString('en-US');
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return parts.replace(/\d/g, (d) => persianDigits[parseInt(d, 10)]).replace(/,/g, '٬');
};

export const PriceBreakdown: React.FC<PriceBreakdownProps> = ({
  item,
  showCappedNote = true,
  className = '',
  compact = false,
}) => {
  if (!item) return null;
  const rows = buildLineRows(item);
  const isSplit = rows.length === 2 && rows[0].kind === 'discounted' && rows[1].kind === 'regular';

  if (rows.length === 0) return null;

  return (
    <div className={`space-y-1.5 text-xs ${className}`}>
      {rows.map((row, idx) => (
        <div
          key={idx}
          className={`flex items-center justify-between gap-2 ${
            row.kind === 'discounted'
              ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
              : 'text-stone-600 dark:text-stone-300'
          }`}
        >
          <div className="flex items-center gap-1.5">
            {row.kind === 'discounted' ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 text-[10px] font-bold">
                <Sparkles className="w-2.5 h-2.5" />
                <span>با {formatPersianNumber(row.discountPercent)}٪ تخفیف</span>
              </span>
            ) : isSplit ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 text-[10px]">
                قیمت اصلی
              </span>
            ) : null}
            <span>
              {formatPersianNumber(row.qty)} عدد × {formatPersianNumber(row.unitPrice)} تومان
            </span>
          </div>
          <span className="font-bold text-stone-900 dark:text-stone-100">
            {formatPersianNumber(row.amount)} تومان
          </span>
        </div>
      ))}

      {isSplit && showCappedNote && (
        <div className="mt-1 flex items-start gap-1.5 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 text-[11px] text-amber-900 dark:text-amber-200 leading-relaxed">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <span>
            تخفیف این محصول فقط برای {formatPersianNumber(rows[0].qty)} عدد اول اعمال می‌شود؛{' '}
            {formatPersianNumber(rows[1].qty)} عدد بعدی با قیمت اصلی محاسبه شده است.
          </span>
        </div>
      )}
    </div>
  );
};
