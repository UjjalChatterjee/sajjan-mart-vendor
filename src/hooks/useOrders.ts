import { useQuery } from '@tanstack/react-query';
import { getOrders } from '../services/order.service';
import type { Order } from '../types';

/**
 * Fetch all orders via TanStack Query.
 *
 * Query key: ['orders']
 *
 * Cache config:
 *   staleTime  30s  — data is considered fresh for 30 seconds
 *   gcTime     30m  — cached data is garbage-collected after 30 minutes of no observers
 *
 * UX:
 *   - Returning from Order Detail shows cached data instantly (no loading spinner).
 *   - Background refetch keeps the list visible.
 */
export function useOrders() {
  return useQuery<Order[], Error>({
    queryKey: ['orders'],
    queryFn: () => getOrders(),
    staleTime: 1000 * 30,      // 30 seconds
    gcTime: 1000 * 60 * 30,   // 30 minutes — survives long sessions on other screens
  });
}
