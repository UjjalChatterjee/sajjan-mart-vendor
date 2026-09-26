import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { Colors } from '../theme/colors';
import { OrderCard } from '../components/OrderCard';
import { EmptyState } from '../components/EmptyState';
import { OrderCardSkeleton } from '../components/LoadingSkeleton';
import { NewOrderAlertModal } from '../components/NewOrderAlertModal';
import { useNavigation } from '../context/NavigationContext';
import { useOrderStore } from '../store/orderStore';
import { useToast } from '../context/ToastContext';
import { useOrders } from '../hooks/useOrders';
import { processOrderItem, markOrderDispatched, markOrderDelivered, cancelApproveItems, cancelRejectItems, getOrders } from '../services/order.service';
import {
  setIncomingOrderHandler,
  removeIncomingOrderHandler,
  setNotificationActionHandler,
  removeNotificationActionHandler,
  handleInitialNotification,
  consumeTappedOrderId,
  setTappedOrderHandler,
  removeTappedOrderHandler,
  stopNativeOrderAlert,
} from '../services/notification.service';
import { ErrorModal } from '../components/ErrorModal';
import { CancelRequestOrderCard } from '../components/CancelRequestOrderCard';
import type { Order, OrderItem } from '../types';

/* ── Fixed tab system with status mapping ── */

type TabDef = {
  key: string;
  label: string;
  statuses: string[];
};

const FIXED_TABS: TabDef[] = [
  { key: 'new_order', label: 'New Order', statuses: ['pending'] },
  { key: 'processing', label: 'Processing', statuses: ['accepted', 'confirmed', 'processing', 'packed'] },
  { key: 'dispatch', label: 'Dispatch', statuses: ['shipped'] },
  { key: 'cancel_request', label: 'Cancel Request', statuses: ['cancel_request'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
  { key: 'completed', label: 'Completed', statuses: ['delivered'] },
];

function ordersInTab(orders: Order[], statuses: string[]): Order[] {
  return orders.filter(o => statuses.includes(o.status));
}

/**
 * Parse items JSON string into OrderItem[].
 * Used when order data arrives via FCM (only items JSON is available).
 */
function parseItemsJson(itemsJson?: string): OrderItem[] {
  if (!itemsJson) return [];
  try {
    const items = JSON.parse(itemsJson);
    if (!Array.isArray(items)) return [];
    return items.map((item: any, index: number) => ({
      id: item.id || String(index + 1),
      name: item.name || `Item ${index + 1}`,
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

/**
 * Build an Order from FCM notification data.
 * Handles whatever data the backend sends in the FCM payload.
 */
function buildOrderFromNotification(data: {
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
}): Order {
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

export function OrdersScreen() {
  const { navigate } = useNavigation();
  const { acceptOrder, rejectOrder } = useOrderStore();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();

  const {
    data: orders = [],
    isLoading,
    isFetching,
    error: queryError,
    refetch,
  } = useOrders();

  const [activeTab, setActiveTab] = useState('new_order');
  const [newOrderVisible, setNewOrderVisible] = useState(false);
  const [pendingNewOrder, setPendingNewOrder] = useState<Order | null>(null);
  // Order ids already surfaced via notification tap — prevents double-open popups
  const tappedOrderIds = useRef<Set<string>>(new Set());
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState('');
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  const [processingItems, setProcessingItems] = useState<Set<string>>(new Set());
  const hasShownError = useRef(false);
  const hasEverLoaded = useRef(false);

  // ── Tab scrolling ──
  const tabsScrollRef = useRef<any>(null);
  const tabLayoutsRef = useRef<Map<string, { x: number; width: number }>>(
    new Map(),
  );
  const lastScrolledTab = useRef('');

  const handleTabLayout = useCallback(
    (
      key: string,
      e: { nativeEvent: { layout: { x: number; width: number } } },
    ) => {
      const { x, width } = e.nativeEvent.layout;
      tabLayoutsRef.current.set(key, { x, width });
    },
    [],
  );

  const scrollToTab = useCallback((key: string) => {
    const layout = tabLayoutsRef.current.get(key);
    // _innerWidth is available at runtime on ScrollView instances
    const sv = tabsScrollRef.current as any;
    const containerWidth: number =
      sv?._innerWidth ?? sv?.props?.style?.width ?? 360;
    if (!layout || !containerWidth) return;

    let offset = layout.x - containerWidth / 2 + layout.width / 2;
    offset = Math.max(0, offset);

    sv?.scrollTo?.({ x: offset, animated: true });
  }, []);

  // Auto-scroll to keep the selected tab visible / centered
  useEffect(() => {
    if (activeTab && activeTab !== lastScrolledTab.current) {
      lastScrolledTab.current = activeTab;
      // Delay slightly so onLayout measurements are available
      const timer = setTimeout(() => scrollToTab(activeTab), 50);
      return () => clearTimeout(timer);
    }
  }, [activeTab, scrollToTab]);

  // Track whether we've ever had data — after first load, never show skeleton again
  if (orders.length > 0) {
    hasEverLoaded.current = true;
  }

  // Show error modal when query fails (only once per error)
  useEffect(() => {
    if (queryError && !hasShownError.current) {
      setErrorModalMessage(queryError.message || 'Failed to load orders');
      setErrorModalVisible(true);
      hasShownError.current = true;
    }
    if (!queryError) {
      hasShownError.current = false;
    }
  }, [queryError]);

  // Register FCM foreground handler — opens modal on new order
  useEffect(() => {
    setIncomingOrderHandler(data => {
      console.log('[ORDER-ALERT] Incoming order via FCM foreground');
      const incoming = buildOrderFromNotification(data);
      setPendingNewOrder(incoming);
      setNewOrderVisible(true);
    });

    // NEW_ORDER notification tap: open the same modal (deduped by order id)
    const openTappedOrder = (orderId: string) => {
      if (!orderId || tappedOrderIds.current.has(orderId)) {
        return;
      }
      tappedOrderIds.current.add(orderId);
      console.log('[ORDER-ALERT] Incoming order via notification tap');

      // Stop the native OrderAlertService (sound + volume bump) before the
      // foreground alert starts, so the two audio owners never overlap.
      stopNativeOrderAlert();

      const openWithFallback = () => {
        const fallback = buildOrderFromNotification({
          orderId,
          customerName: '',
          itemCount: '0',
          total: '0',
        });
        setPendingNewOrder(fallback);
        setNewOrderVisible(true);
      };

      // Fetch the complete order so the modal shows real details
      getOrders()
        .then(orders => {
          const full = orders.find(o => o.id === orderId);
          if (full) {
            setPendingNewOrder(full);
            setNewOrderVisible(true);
          } else {
            openWithFallback();
          }
        })
        .catch(() => openWithFallback());
    };

    // Process any pending notification from killed-state launch
    handleInitialNotification().then(data => {
      if (data) {
        console.log('[ORDER-ALERT] Pending order from killed-state launch');
        if (data.orderId && tappedOrderIds.current.has(data.orderId)) {
          return;
        }
        if (data.orderId) {
          tappedOrderIds.current.add(data.orderId);
        }
        const incoming = buildOrderFromNotification(data);
        setPendingNewOrder(incoming);
        setNewOrderVisible(true);
      }
    });

    // Cold start via notification tap: pull the stashed order id
    consumeTappedOrderId().then(orderId => {
      if (orderId) {
        openTappedOrder(orderId);
      }
    });

    // Tap while the app is running: MainActivity pushes the order id
    setTappedOrderHandler(openTappedOrder);

    return () => {
      removeIncomingOrderHandler();
      removeTappedOrderHandler();
    };
  }, []);

  // Register notification action handler (ACCEPT/REJECT from notification buttons)
  useEffect(() => {
    setNotificationActionHandler(async ({ action, orderId }) => {
      try {
        if (action === 'ORDER_ACCEPT') {
          console.log('[ORDER-ACTION] ACCEPT from notification');
          await acceptOrder(orderId);
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          showSuccess('Order accepted');
        } else if (action === 'ORDER_REJECT') {
          console.log('[ORDER-ACTION] REJECT from notification');
          await rejectOrder(orderId);
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          showSuccess('Order rejected');
        }
      } catch {
        // Notification actions are fire-and-forget; errors are non-critical
      }
    });
    return () => removeNotificationActionHandler();
  }, [acceptOrder, rejectOrder, queryClient, showSuccess]);


  // Pull-to-refresh via TanStack Query
  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  // ── Confirmed order: Mark Dispatched ──
  const handleMarkDispatched = useCallback(
    async (orderId: string) => {
      setDispatchingId(orderId);
      try {
        await markOrderDispatched(orderId);
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Order marked as dispatched');
      } catch (err) {
        showError(
          err instanceof Error ? err.message : 'Failed to mark order as dispatched',
        );
      } finally {
        setDispatchingId(null);
      }
    },
    [queryClient, showSuccess, showError],
  );

  // ── Confirmed order: Process Item (Ready) ──
  const handleItemReady = useCallback(
    async (orderId: string, itemId: string) => {
      setProcessingItems(prev => new Set(prev).add(itemId));
      try {
        await processOrderItem(orderId, itemId, 'ready');
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Item marked as ready');
      } catch (err) {
        showError(
          err instanceof Error ? err.message : 'Failed to mark item as ready',
        );
      } finally {
        setProcessingItems(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
    },
    [queryClient, showSuccess, showError],
  );

  // ── Shipped order: Mark Delivered ──
  const handleMarkDelivered = useCallback(
    async (orderId: string) => {
      setDeliveringId(orderId);
      try {
        await markOrderDelivered(orderId);
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Order marked as delivered');
      } catch (err) {
        showError(
          err instanceof Error ? err.message : 'Failed to mark order as delivered',
        );
      } finally {
        setDeliveringId(null);
      }
    },
    [queryClient, showSuccess, showError],
  );

  // ── Confirmed order: Process Item (Cancel) ──
  const handleItemCancel = useCallback(
    async (orderId: string, itemId: string) => {
      setProcessingItems(prev => new Set(prev).add(itemId));
      try {
        await processOrderItem(orderId, itemId, 'cancel');
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Item cancelled');
      } catch (err) {
        showError(
          err instanceof Error ? err.message : 'Failed to cancel item',
        );
      } finally {
        setProcessingItems(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
    },
    [queryClient, showSuccess, showError],
  );

  // Fixed tabs with counts
  const tabs = FIXED_TABS.map(tab => ({
    ...tab,
    count: ordersInTab(orders, tab.statuses).length,
  }));

  // Active tab statuses
  const activeTabDef = FIXED_TABS.find(t => t.key === activeTab) ?? FIXED_TABS[0];

  // Filtering by tab statuses
  const filteredOrders = ordersInTab(orders, activeTabDef.statuses).sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const pendingCount = orders.filter(o => o.status === 'pending').length;

  // Modal actions — delegate to store + invalidate cache
  const handleModalAccept = useCallback(
    async (orderId: string) => {
      try {
        console.log('[ORDER-ACTION] ACCEPT via modal');
        await acceptOrder(orderId);
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Order accepted successfully');
      } catch (err) {
        setErrorModalMessage(
          err instanceof Error ? err.message : 'Failed to accept order',
        );
        setErrorModalVisible(true);
      } finally {
        setNewOrderVisible(false);
        setPendingNewOrder(null);
      }
    },
    [acceptOrder, queryClient, showSuccess],
  );

  const handleModalReject = useCallback(
    async (orderId: string) => {
      setRejectingId(orderId);
      try {
        console.log('[ORDER-ACTION] REJECT via modal');
        await rejectOrder(orderId);
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        showSuccess('Order rejected successfully');
      } catch (err) {
        setErrorModalMessage(
          err instanceof Error ? err.message : 'Failed to reject order',
        );
        setErrorModalVisible(true);
      } finally {
        setRejectingId(null);
        setNewOrderVisible(false);
        setPendingNewOrder(null);
      }
    },
    [rejectOrder, queryClient, showSuccess],
  );

  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerLogo}>
            <View style={styles.logoMark}>
              <View style={styles.logoLeafTop} />
              <View style={styles.logoLeafBottom} />
            </View>
          </View>
          <Text style={styles.headerTitle}>Orders</Text>
          {pendingCount > 0 && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingBadgeText}>{pendingCount}</Text>
            </View>
          )}
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.iconBtn}
            activeOpacity={0.6}
            onPress={() => navigate('notifications')}
          >
            <Text style={styles.iconEmoji}>🔔</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.avatar}
            activeOpacity={0.6}
            onPress={() => navigate('settings')}
          >
            <Text style={styles.avatarText}>S</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Filter Tabs — horizontally scrollable */}
      <ScrollView
        ref={tabsScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabsInner}
      >
        {tabs.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              onLayout={e => handleTabLayout(tab.key, e)}
              activeOpacity={0.7}
            >
              <Text
                numberOfLines={1}
                style={[styles.tabText, isActive && styles.tabTextActive]}
              >
                {tab.label}
              </Text>
              <View
                style={[styles.tabCount, isActive && styles.tabCountActive]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.tabCountText,
                    isActive && styles.tabCountTextActive,
                  ]}
                >
                  {tab.count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Order List */}
      {isLoading && !hasEverLoaded.current ? (
        <View>
          <View>
            <OrderCardSkeleton />
            <OrderCardSkeleton />
            <OrderCardSkeleton />
          </View>
        </View>
      ) : filteredOrders.length === 0 ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            title={`No ${activeTabDef.label} orders`}
            subtitle={`${activeTabDef.label} orders will show up here.`}
            icon={'🛒'}
          />
        </View>
      ) : (
        <FlatList
          style={styles.orderList}
          data={filteredOrders}
          keyExtractor={item => item.id}
          contentContainerStyle={[
            styles.orderListContent,
            {
              paddingBottom: insets.bottom + 24,
            },
          ]}
          showsVerticalScrollIndicator={false}
          refreshing={isFetching && !isLoading}
          onRefresh={handleRefresh}
          renderItem={({ item }) => {
            if (item.status === 'cancel_request') {
              return (
                <CancelRequestOrderCard
                  order={item}
                  onApproveItem={async () => {
                    await cancelApproveItems(item.id, []);
                  }}
                  onRejectItem={async () => {
                    await cancelRejectItems(item.id, []);
                  }}
                  onApproveSelected={async (_orderId, itemIds) => {
                    await cancelApproveItems(item.id, itemIds);
                  }}
                  onRejectSelected={async (_orderId, itemIds) => {
                    await cancelRejectItems(item.id, itemIds);
                  }}
                  queryClient={queryClient}
                  showSuccess={showSuccess}
                  showError={showError}
                />
              );
            }

            return (
              <OrderCard
                order={item}
                isAccepting={acceptingId === item.id}
                onAccept={async orderId => {
                  setAcceptingId(orderId);
                  try {
                    await acceptOrder(orderId);
                    queryClient.invalidateQueries({ queryKey: ['orders'] });
                    showSuccess('Order accepted successfully');
                  } catch (err) {
                    setErrorModalMessage(
                      err instanceof Error ? err.message : 'Failed to accept order',
                    );
                    setErrorModalVisible(true);
                  } finally {
                    setAcceptingId(null);
                  }
                }}
                isRejecting={rejectingId === item.id}
                onReject={async orderId => {
                  setRejectingId(orderId);

                  try {
                    await rejectOrder(orderId);
                    queryClient.invalidateQueries({ queryKey: ['orders'] });
                    showSuccess('Order rejected successfully');
                  } catch (err) {
                    setErrorModalMessage(
                      err instanceof Error
                        ? err.message
                        : 'Failed to reject order',
                    );
                    setErrorModalVisible(true);
                  } finally {
                    setRejectingId(null);
                  }
                }}
                onMarkDispatched={handleMarkDispatched}
                isDispatching={dispatchingId === item.id}
                onItemReady={handleItemReady}
                onItemCancel={handleItemCancel}
                processingItems={processingItems}
                onMarkDelivered={handleMarkDelivered}
                isDelivering={deliveringId === item.id}
              />
            );
          }}
        />
      )}

      {/* New Order Alert — the ONLY place with Accept/Reject */}
      <NewOrderAlertModal
        visible={newOrderVisible}
        order={pendingNewOrder}
        onAccept={handleModalAccept}
        onReject={handleModalReject}
      />

      {/* Error Modal */}
      <ErrorModal
        visible={errorModalVisible}
        title="Failed to Load Orders"
        message={errorModalMessage}
        onClose={() => setErrorModalVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.screenBg,
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 14,
  },

  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerLogo: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoMark: {
    position: 'relative',
    width: 36,
    height: 36,
  },
  logoLeafTop: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.9)',
    top: 8,
    left: 6,
  },
  logoLeafBottom: {
    position: 'absolute',
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: Colors.primaryLight,
    top: 12,
    left: 10,
  },
  headerTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: Colors.gray900,
  },
  pendingBadge: {
    backgroundColor: Colors.pending,
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  pendingBadgeText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconEmoji: {
    fontSize: 17,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  // Tabs
  tabsScroll: {
    flexGrow: 0,
    flexShrink: 0,
    marginBottom: 0,
  },

  tabsInner: {
    paddingHorizontal: 18,
    gap: 10,
    paddingVertical: 4,
  },

  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 7,
    flexShrink: 0,
  },

  tabActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },

  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.gray600,
    flexShrink: 0,
  },

  tabTextActive: {
    color: Colors.white,
  },

  tabCount: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    flexShrink: 0,
  },

  tabCountActive: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },

  tabCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.gray600,
  },

  tabCountTextActive: {
    color: Colors.white,
  },

  // Order list
  orderList: {
    flex: 1,
    minHeight: 0,
  },

  orderListContent: {
    paddingHorizontal: 18,
    paddingTop: 12,
    alignItems: 'stretch',
  },

  emptyContainer: {
    flex: 1,
  },
});
