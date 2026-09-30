import type { Order, OrderItem } from '../types';

/**
 * FCM NEW_ORDER payload -> Order.
 *
 * A push carries no API row, so this is the only path that can produce the
 * order the popup shows. The food markers therefore have to survive the JSON
 * round trip: without `itemType`/`productType` a FOOD order looks like a
 * product order and the Making Time selector never appears. A push from a
 * backend that predates those fields carries neither, which is why the alert
 * is re-read from the API before the vendor decides (see OrdersScreen).
 */

export interface NewOrderPushData {
  orderId: string;
  orderNumber?: string;
  customerName: string;
  customerPhone?: string;
  address?: string;
  itemCount: string;
  total: string;
  paymentMethod?: string;
  paymentStatus?: string;
  items?: string;
}

export function parseItemsJson(itemsJson?: string): OrderItem[] {
  if (!itemsJson) return [];
  try {
    const items = JSON.parse(itemsJson);
    if (!Array.isArray(items)) return [];
    return items.map((item: any, index: number) => ({
      id: item.id || String(index + 1),
      name: item.name || `Item ${index + 1}`,
      itemType: item.itemType ?? item.item_type,
      productType:
        item.productType ?? item.product_type ?? item.product?.product_type,
      variantName: item.variantName,
      quantity: Number(item.quantity) || 1,
      price: Number(item.price) || 0,
      unit: item.unit,
      image: item.image,
      total: Number(item.total) || (Number(item.price) || 0) * (Number(item.quantity) || 1),
      ready: false,
      cancelled: false,
    }));
  } catch {
    return [];
  }
}

export function buildOrderFromNotification(data: NewOrderPushData): Order {
  const items = parseItemsJson(data.items);

  // If no items JSON, create placeholder items from itemCount
  const placeholderItems = items.length > 0 ? items : Array.from(
    { length: parseInt(data.itemCount, 10) || 0 },
    (_, i) => ({
      id: String(i + 1),
      name: `Item ${i + 1}`,
      quantity: 1,
      price: 0,
      total: 0,
      ready: false,
      cancelled: false,
    }),
  );

  return {
    id: data.orderId,
    orderNumber: data.orderNumber,
    customerName: data.customerName || 'Customer',
    customerPhone: data.customerPhone || '',
    deliveryAddress: data.address || '',
    // 'pending' here means "the alert is asking for a decision", not "the
    // database says pending": a push carries no status, and a second device may
    // already have decided. The row re-read by mergeAlertOrder is authoritative.
    status: 'pending' as const,
    items: placeholderItems,
    subtotal: parseInt(data.total, 10) || 0,
    discount: 0,
    deliveryCharge: 0,
    tax: 0,
    grandTotal: parseInt(data.total, 10) || 0,
    createdAt: new Date().toISOString(),
    paymentMethod: data.paymentMethod,
    paymentStatus: data.paymentStatus,
  };
}

/**
 * Replace an alert's payload-built order with the same order as the API
 * returned it, keeping the status the alert was opened with.
 *
 * Returns `prev` untouched when there is nothing open, the ids differ (the
 * vendor moved on to another alert) or the read produced nothing — a late
 * response must never resurrect a dismissed modal or describe a different order.
 */
export function mergeAlertOrder(prev: Order | null, fresh: Order | null): Order | null {
  if (!prev || !fresh || prev.id !== fresh.id) return prev;
  return { ...fresh, status: prev.status };
}
