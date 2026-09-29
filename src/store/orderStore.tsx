/**
 * Order Store
 *
 * Centralised, single-source-of-truth state for all order data.
 * UI components consume this context — they never touch the service directly.
 *
 * Architecture:
 *   UI  →  orderStore  →  order.service  →  mock data (now) / REST API (future)
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import type { Order } from '../types';
import * as orderService from '../services/order.service';

/* ── State shape ── */

interface OrderStoreState {
  orders: Order[];
  isLoading: boolean;
  error: string | null;
}

/* ── Actions ── */

interface OrderStoreActions {
  loadOrders: () => Promise<void>;
  acceptOrder: (id: string) => Promise<void>;
  rejectOrder: (id: string) => Promise<void>;
  addIncomingOrder: (order: Order) => void;
}

type OrderStoreContextType = OrderStoreState & OrderStoreActions;

/* ── Context ── */

const OrderStoreContext = createContext<OrderStoreContextType | undefined>(
  undefined,
);

/* ── Provider ── */

export function OrderStoreProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── Load orders ── */
  const loadOrders = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await orderService.getOrders();
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /* ── Accept ── */
  const accept = useCallback(async (id: string) => {
    await orderService.acceptOrder(id);
  }, []);

  /* ── Reject ── */
  const reject = useCallback(async (id: string) => {
    try {
      await orderService.rejectOrder(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject order');
      // Rethrow: callers must be able to tell a real failure — and the 409
      // "already decided on another device" case — from a successful reject.
      throw err;
    }
  }, []);

  /* ── Add incoming order (from mock simulation or future FCM) ── */
  const addIncomingOrder = useCallback((order: Order) => {
    setOrders(prev => [order, ...prev]);
  }, []);

  /* ── Value ── */
  const value = useMemo<OrderStoreContextType>(
    () => ({
      orders,
      isLoading,
      error,
      loadOrders,
      acceptOrder: accept,
      rejectOrder: reject,
      addIncomingOrder,
    }),
    [
      orders,
      isLoading,
      error,
      loadOrders,
      accept,
      reject,
      addIncomingOrder,
    ],
  );

  return (
    <OrderStoreContext.Provider value={value}>
      {children}
    </OrderStoreContext.Provider>
  );
}

/* ── Hook ── */

export function useOrderStore(): OrderStoreContextType {
  const context = useContext(OrderStoreContext);
  if (!context) {
    throw new Error('useOrderStore must be used within OrderStoreProvider');
  }
  return context;
}
