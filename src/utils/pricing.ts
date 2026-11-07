/**
 * Authoritative client-side mirror of the server pricing formula:
 * U = round(B * (100 - D) / 100)
 * promo quota K from size-level specialOfferStock, falling back to product-level specialOfferStock.
 * First min(Q, K) cost U, remainder cost B.
 */

export interface PricingProduct {
  id?: number | string;
  price?: number;
  discount?: number;
  discountPercent?: number;
  isAmazingOffer?: boolean;
  isSpecialOffer?: boolean;
  specialOfferStock?: number;
  stock?: number;
  sizes?: Array<{
    name?: string;
    size?: string;
    price?: number;
    stock?: number;
    specialOfferStock?: number;
    isOutOfStock?: boolean;
  }>;
}

export interface LinePriceResult {
  basePrice: number;
  unitPrice: number;
  discountedUnitPrice: number;
  discountPercent: number;
  discountedQty: number;
  discountedUnits: number;
  discountedQuantity: number;
  regularQty: number;
  regularUnits: number;
  regularQuantity: number;
  discountedSubtotal: number;
  regularSubtotal: number;
  lineTotal: number;
  totalPrice: number;
  effectiveUnitPrice: number;
  quota: number | null;
  capped: boolean;
  stock: number;
  invalidSize: boolean;
}

export interface PriceRow {
  kind: 'discounted' | 'regular' | 'plain';
  qty: number;
  unitPrice: number;
  amount: number;
  discountPercent: number;
}

export function computeLinePrice(
  product: PricingProduct,
  sizeName: string = '',
  quantity: number = 1
): LinePriceResult {
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  let basePrice = Math.max(0, Number(product?.price) || 0);
  let stock = product?.stock !== undefined ? Number(product.stock) : 999;
  let quota: number | null = null;
  let selectedSize: any = null;
  let invalidSize = false;

  if (
    product?.specialOfferStock !== undefined &&
    product?.specialOfferStock !== null &&
    (product.specialOfferStock as any) !== ''
  ) {
    quota = Math.max(0, Math.floor(Number(product.specialOfferStock)));
  }

  const sizeTrimmed = (sizeName || '').trim();
  if (sizeTrimmed && Array.isArray(product?.sizes) && product.sizes.length > 0) {
    const sizeObj = product.sizes.find(
      (s) => (s.name ?? s.size ?? '').trim() === sizeTrimmed
    );
    if (sizeObj) {
      selectedSize = sizeObj;
      if (sizeObj.price !== undefined && sizeObj.price !== null) {
        basePrice = Math.max(0, Number(sizeObj.price) || 0);
      }
      if (sizeObj.stock !== undefined && sizeObj.stock !== null) {
        stock = Number(sizeObj.stock);
      }
      if (
        sizeObj.specialOfferStock !== undefined &&
        sizeObj.specialOfferStock !== null &&
        (sizeObj.specialOfferStock as any) !== ''
      ) {
        quota = Math.max(0, Math.floor(Number(sizeObj.specialOfferStock)));
      }
    } else {
      invalidSize = true;
    }
  }

  let rawDiscount = 0;
  if (selectedSize && (selectedSize.discount !== undefined || selectedSize.discountPercent !== undefined)) {
    rawDiscount = Number(selectedSize.discount ?? selectedSize.discountPercent ?? 0);
  } else if (product) {
    rawDiscount = Number(product.discount ?? product.discountPercent ?? 0);
  }

  const discountPercent = Math.max(0, Math.min(99, Math.floor(rawDiscount)));

  let discountedUnitPrice = basePrice;
  if (discountPercent > 0) {
    discountedUnitPrice = Math.round((basePrice * (100 - discountPercent)) / 100);
  }

  let discountedQty = 0;
  let regularQty = qty;

  if (discountPercent > 0 && discountedUnitPrice < basePrice) {
    if (quota === null) {
      discountedQty = qty;
      regularQty = 0;
    } else {
      discountedQty = Math.min(qty, Math.max(0, quota));
      regularQty = qty - discountedQty;
    }
  } else {
    discountedUnitPrice = basePrice;
    discountedQty = 0;
    regularQty = qty;
  }

  const discountedSubtotal = discountedQty * discountedUnitPrice;
  const regularSubtotal = regularQty * basePrice;
  const lineTotal = discountedSubtotal + regularSubtotal;
  const effectiveUnitPrice = qty > 0 ? Math.round(lineTotal / qty) : basePrice;
  const capped = quota !== null && discountPercent > 0 && qty > quota;

  return {
    basePrice,
    unitPrice: basePrice,
    discountedUnitPrice,
    discountPercent,
    discountedQty,
    discountedUnits: discountedQty,
    discountedQuantity: discountedQty,
    regularQty,
    regularUnits: regularQty,
    regularQuantity: regularQty,
    discountedSubtotal,
    regularSubtotal,
    lineTotal,
    totalPrice: lineTotal,
    effectiveUnitPrice,
    quota,
    capped,
    stock,
    invalidSize,
  };
}

export function buildLineRows(item: any): PriceRow[] {
  if (!item) return [];
  const qty = Math.max(1, Number(item.quantity) || 1);
  const basePrice = item.basePrice !== undefined && item.basePrice !== null ? Number(item.basePrice) : Number(item.unitPrice || 0);
  const discPercent = Number(item.discountPercent || 0);
  const discQty = item.discountedQuantity !== undefined
    ? Number(item.discountedQuantity)
    : (item.discountedUnits !== undefined ? Number(item.discountedUnits) : (item.discountedQty !== undefined ? Number(item.discountedQty) : 0));
  const regQty = item.regularQuantity !== undefined
    ? Number(item.regularQuantity)
    : (item.regularUnits !== undefined ? Number(item.regularUnits) : (item.regularQty !== undefined ? Number(item.regularQty) : (qty - discQty)));
  const discUnitPrice = item.discountedUnitPrice !== undefined && Number(item.discountedUnitPrice) > 0
    ? Number(item.discountedUnitPrice)
    : (discPercent > 0 ? Math.round((basePrice * (100 - discPercent)) / 100) : basePrice);

  if (discPercent > 0 && discQty > 0) {
    const rows: PriceRow[] = [
      {
        kind: 'discounted',
        qty: discQty,
        unitPrice: discUnitPrice,
        amount: discQty * discUnitPrice,
        discountPercent: discPercent,
      },
    ];
    if (regQty > 0) {
      rows.push({
        kind: 'regular',
        qty: regQty,
        unitPrice: basePrice,
        amount: regQty * basePrice,
        discountPercent: 0,
      });
    }
    return rows;
  }

  const totalPrice = item.totalPrice !== undefined && item.totalPrice !== null ? Number(item.totalPrice) : (item.lineTotal !== undefined ? Number(item.lineTotal) : qty * basePrice);
  const unitPrice = qty > 0 ? Math.round(totalPrice / qty) : totalPrice;
  return [
    {
      kind: 'plain',
      qty,
      unitPrice,
      amount: totalPrice,
      discountPercent: 0,
    },
  ];
}

export function cartLineTotal(
  product: PricingProduct,
  sizeName: string = '',
  quantity: number = 1
): number {
  return computeLinePrice(product, sizeName, quantity).lineTotal;
}
