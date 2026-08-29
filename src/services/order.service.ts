/**
 * Order Service
 *
 * Centralised data layer for order operations.
 * Fetches from REST API: GET /api/orders?user_id=<userId>&order=created_at&dir=desc
 */

import { apiGet, apiPost, apiPut } from './api.client';
import type { Order, OrderAddress, OrderAmounts, BackendOrder, OrderItem, BackendOrderItem } from '../types';

/* ── Field mapping: Backend → UI ─────────────────────────────────────── */

function mapBackendItem(item: BackendOrderItem): OrderItem {
  return {
    id: String(item.id),
    name: item.product_name || item.name || 'Item',
    variantName: item.variant_name ?? undefined,
    quantity: Number(item.quantity) || 0,
    price: Number(item.unit_price) || 0,
    unit: item.unit,
    image: item.image_url,
    total: Number(item.total) || 0,
    ready: item.ready === true,
    cancelled: item.cancelled === true,
  };
}

function extractAddress(addr: BackendOrder['address']): string {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const a = addr as Record<string, unknown>;
  const parts: string[] = [];
  if (a.line1) parts.push(String(a.line1));
  if (a.line2) parts.push(String(a.line2));
  if (a.city) parts.push(String(a.city));
  if (a.state) parts.push(String(a.state));
  if (a.pincode) parts.push(String(a.pincode));
  return parts.join(', ');
}

function parseStructuredAddress(addr: BackendOrder['address']): OrderAddress | undefined {
  if (!addr || typeof addr === 'string') return undefined;
  const a = addr as Record<string, unknown>;
  return {
    fullName: a.full_name ? String(a.full_name) : undefined,
    phone: a.phone ? String(a.phone) : undefined,
    line1: a.line1 ? String(a.line1) : undefined,
    line2: a.line2 ? String(a.line2) : undefined,
    city: a.city ? String(a.city) : undefined,
    state: a.state ? String(a.state) : undefined,
    pincode: a.pincode ? String(a.pincode) : undefined,
  };
}

function mapBackendOrder(raw: BackendOrder): Order {
  const items: OrderItem[] = Array.isArray(raw.order_items)
    ? raw.order_items.map(mapBackendItem)
    : [];

  const customerName = raw.user?.name || raw.user?.email || 'Customer';
  const customerPhone = raw.user?.phone || '';

  const structuredAddr = parseStructuredAddress(raw.address);

  // Amounts
  const rawAmounts = raw.amounts as Record<string, unknown> | undefined;
  const amounts: OrderAmounts | undefined = rawAmounts
    ? {
        originalTotal: Number(rawAmounts.original_total) || undefined,
        originalSubtotal: Number(rawAmounts.original_subtotal) || undefined,
        activeSubtotal: Number(rawAmounts.active_subtotal) || undefined,
        cancelledSubtotal: Number(rawAmounts.cancelled_subtotal) || undefined,
        updatedTax: Number(rawAmounts.updated_tax) || undefined,
        updatedShipping: Number(rawAmounts.updated_shipping) || undefined,
        updatedTotal: Number(rawAmounts.updated_total) || undefined,
        refundDueTotal: Number(rawAmounts.refund_due_total) || undefined,
        refundPending: rawAmounts.refund_pending === true,
        codCollect: Number(rawAmounts.cod_collect) || undefined,
        hasCancellation: rawAmounts.has_cancellation === true,
        fullyCancelled: rawAmounts.fully_cancelled === true,
      }
    : undefined;

  return {
    id: raw.id,
    orderNumber: raw.order_number,
    customerName,
    customerPhone,
    deliveryAddress: extractAddress(raw.address),
    address: structuredAddr,
    amounts,
    items,
    status: raw.status as Order['status'],
    subtotal: Number(raw.subtotal) || 0,
    discount: Number(raw.discount) || 0,
    deliveryCharge: Number(raw.shipping) || 0,
    tax: Number(raw.tax) || 0,
    grandTotal: Number(raw.total) || 0,
    createdAt: raw.created_at,
    notes: raw.notes ?? undefined,
    paymentMethod: raw.payment_method,
    paymentStatus: raw.payment_status,
  };
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Fetch all orders (admin/seller view).
 *
 * GET /api/orders?order=created_at&dir=desc
 */
export async function getOrders(): Promise<Order[]> {
  const path = `/api/orders?order=created_at&dir=desc`;
  const raw = await apiGet<BackendOrder[] | { data: BackendOrder[] }>(path);

  // Handle both direct array and wrapped { data: [...] } responses
  const list: BackendOrder[] = Array.isArray(raw) ? raw : (raw as { data: BackendOrder[] }).data || [];

  return list.map(mapBackendOrder);
}

/**
 * Accept an order.
 *
 * PUT /api/orders/{orderId}
 * Body: { "status": "confirmed" }
 */
export async function acceptOrder(orderId: string): Promise<void> {
  await apiPut(`/api/orders/${encodeURIComponent(orderId)}`, {
    status: 'confirmed',
  });
}

/**
 * Reject an order.
 *
 * PUT /api/orders/{orderId}
 * Body: { "status": "cancelled" }
 */
export async function rejectOrder(orderId: string): Promise<void> {
  await apiPut(`/api/orders/${encodeURIComponent(orderId)}`, {
    status: 'cancelled',
  });
}

/**
 * Process an order item (ready or cancel).
 *
 * POST /api/orders/{orderId}/process-item
 * Body: { "item_id": "{itemId}", "action": "ready" | "cancel" }
 */
export async function processOrderItem(
  orderId: string,
  itemId: string,
  action: 'ready' | 'cancel',
): Promise<void> {
  await apiPost(
    `/api/orders/${encodeURIComponent(orderId)}/process-item`,
    { item_id: itemId, action },
  );
}

/**
 * Mark an order as dispatched (shipped).
 *
 * PUT /api/orders/{orderId}
 * Body: { "status": "shipped" }
 */
export async function markOrderDispatched(orderId: string): Promise<void> {
  await apiPut(`/api/orders/${encodeURIComponent(orderId)}`, {
    status: 'shipped',
  });
}

/**
 * Mark an order as delivered.
 *
 * PUT /api/orders/{orderId}
 * Body: { "status": "delivered" }
 */
export async function markOrderDelivered(orderId: string): Promise<void> {
  await apiPut(`/api/orders/${encodeURIComponent(orderId)}`, {
    status: 'delivered',
  });
}

/**
 * Simulate an incoming new order (dev/testing only).
 * Preserved for FCM notification testing.
 */
export function simulateNewOrder(): Order {
  return {
    id: `SM-${Math.floor(1000 + Math.random() * 9000)}`,
    customerName: 'New Customer',
    customerPhone: '+91 90000 00000',
    deliveryAddress: '12, Test Road, Kolkata',
    status: 'pending',
    items: [
      { id: '1', name: 'Test Item', quantity: 1, price: 100, total: 100, ready: false, cancelled: false },
    ],
    subtotal: 100,
    discount: 0,
    deliveryCharge: 30,
    tax: 0,
    grandTotal: 130,
    createdAt: new Date().toISOString(),
  };
}
