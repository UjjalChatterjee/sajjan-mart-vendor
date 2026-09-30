export interface OrderItem {
  id: string;
  name: string;
  variantName?: string;
  quantity: number;
  price: number;
  unit?: string;
  image?: string;
  total: number;
  ready: boolean;
  cancelled: boolean;
  /** 'product' | 'puja' | 'food' — 'food' is what makes an order cookable. */
  itemType?: string;
  /** order_items.product.product_type: the live marker behind the snapshot. */
  productType?: string;
}

export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'cancel_request'
  | 'return'
  | 'refunded';

export interface OrderAddress {
  fullName?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export interface OrderAmounts {
  originalTotal?: number;
  originalSubtotal?: number;
  activeSubtotal?: number;
  cancelledSubtotal?: number;
  updatedTax?: number;
  updatedShipping?: number;
  updatedTotal?: number;
  refundDueTotal?: number;
  refundPending?: boolean;
  codCollect?: number;
  hasCancellation?: boolean;
  fullyCancelled?: boolean;
}

export interface Order {
  id: string;
  orderNumber?: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  address?: OrderAddress;
  amounts?: OrderAmounts;
  items: OrderItem[];
  status: OrderStatus;
  subtotal: number;
  discount: number;
  deliveryCharge: number;
  tax: number;
  grandTotal: number;
  createdAt: string;
  notes?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  /** Item ids for which cancellation was explicitly requested (status = cancel_request). */
  cancel_request_items?: string[];
  /** Food preparation timer. All three are written by the server on accept. */
  preparationTimeMinutes?: number;
  acceptedAt?: string;
  preparationDueAt?: string;
}

export type Screen = 'login' | 'register' | 'orders' | 'notifications' | 'settings';
export type OrderFilter = 'all' | 'accepted' | 'rejected';

/* ── Backend API response types ─────────────────────────────────────── */

export interface BackendOrderUser {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
}

export interface BackendOrderItem {
  id: string;
  product_name?: string;
  name?: string;
  variant_name?: string | null;
  quantity: number;
  unit_price: number;
  total: number;
  unit?: string;
  image_url?: string;
  ready?: boolean;
  cancelled?: boolean;
  refunded?: boolean;
  item_type?: string;
  /** The linked product record, when the item still points at one. */
  product?: { product_type?: string } | null;
}

export interface BackendOrder {
  id: string;
  user_id: string;
  order_number: string;
  status: string;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  coupon_code: string | null;
  payment_method: string;
  payment_status: string;
  address: Record<string, unknown> | string | null;
  notes: string | null;
  has_food: boolean;
  cancel_requested_at?: string | null;
  cancel_reason?: string | null;
  previous_status?: string | null;
  refunded_amount?: number | null;
  preparation_time_minutes?: number | null;
  accepted_at?: string | null;
  preparation_due_at?: string | null;
  created_at: string;
  updated_at: string;
  user?: BackendOrderUser;
  order_items: BackendOrderItem[];
  amounts?: Record<string, unknown>;
  /** Item ids for which cancellation was explicitly requested. */
  cancel_request_items?: string[];
}
