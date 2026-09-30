import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ScrollView,
  Image,
  PanResponder,
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
import { ApiError } from '../services/api.client';
import {
  applyOrderDecision,
  dismissStaleAlert,
  reconcileAlertsWithBackend,
  subscribeOrderDecisions,
} from '../services/orderAlertSync';
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
  markOrderAlerted,
} from '../services/notification.service';
import { stopOrderAlertSound } from '../services/sound.service';
import { stopOrderVibration } from '../services/orderVibration';
import { showsPreparationTimer } from '../services/prepTimer';
import { buildOrderFromNotification, mergeAlertOrder } from '../services/pushOrder';
import { ErrorModal } from '../components/ErrorModal';
import { CancelRequestOrderCard } from '../components/CancelRequestOrderCard';
import type { Order } from '../types';

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
  // Alert dedup lives in notification.service (markOrderAlerted) so the
  // foreground push, the buffered replay, the tap and the killed-launch paths
  // all share one guard.
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState('');
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  const [processingItems, setProcessingItems] = useState<Set<string>>(new Set());
  const hasShownError = useRef(false);
  const hasEverLoaded = useRef(false);

  // Mirror of the modal's order id so the cross-device decision subscriber can
  // close it without re-creating the effect on every modal change.
  const pendingOrderIdRef = useRef<string | null>(null);
  useEffect(() => {
    pendingOrderIdRef.current = pendingNewOrder?.id ?? null;
  }, [pendingNewOrder]);

  /**
   * A push describes an order; it is not the order. The alert opens from the
   * payload at once (the vendor must be told immediately) and is then re-read
   * from the API so the popup works from the same record every other device
   * sees — the item markers the Making Time selector needs, and the amounts.
   *
   * `status` deliberately stays as the alert reported it: this only corrects
   * order *content*, never order *state*, which cross-device sync owns.
   */
  const hydrateAlertOrder = useCallback((orderId: string | undefined) => {
    if (!orderId) return;
    getOrders()
      .then(list => {
        const fresh = list.find(o => o.id === orderId);
        setPendingNewOrder(prev => mergeAlertOrder(prev, fresh ?? null));
      })
      .catch(() => {
        // A failed read keeps the payload's data instead of inventing any.
      });
  }, []);

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
      hydrateAlertOrder(data.orderId);
    });

    // NEW_ORDER notification tap: open the same modal (deduped by order id)
    const openTappedOrder = (orderId: string) => {
      if (!orderId || !markOrderAlerted(orderId)) {
        return;
      }
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
        if (data.orderId && !markOrderAlerted(data.orderId)) {
          return;
        }
        const incoming = buildOrderFromNotification(data);
        setPendingNewOrder(incoming);
        setNewOrderVisible(true);
        hydrateAlertOrder(data.orderId);
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
      // Navigating away (Settings / Notification Settings) unmounts the modal
      // without it ever reaching Accept/Reject. Without this the native
      // MediaPlayer keeps looping for the rest of the process life, and its
      // "already playing" guard then mutes every later alert. The repeating
      // haptic ends on the same rule — one owner leaving must not leave the
      // motor buzzing for an alert nobody can act on.
      stopOrderAlertSound();
      stopOrderVibration();
    };
    // hydrateAlertOrder is a stable useCallback, so this effect still runs once.
  }, [hydrateAlertOrder]);

  // Another device (or a notification button) decided one of our alerted
  // orders: close its modal. Sound, notification and cache are handled by
  // orderAlertSync — this is only the UI half.
  useEffect(
    () =>
      subscribeOrderDecisions(orderId => {
        if (pendingOrderIdRef.current !== orderId) return;
        pendingOrderIdRef.current = null;
        setNewOrderVisible(false);
        setPendingNewOrder(null);
      }),
    [],
  );

  // Offline / missed-push recovery: whenever the list refreshes, drop any alert
  // whose order is no longer pending. An already completed order is never shown
  // as pending again. (App.tsx runs the same reconciliation on foregrounding,
  // so it also covers the screens where no order list is mounted.)
  useEffect(() => {
    if (orders.length > 0) {
      reconcileAlertsWithBackend(orders);
    }
  }, [orders]);

  /**
   * Make this device's decision, then clean up locally. A 409 means another
   * device already moved the order out of pending — the alert is stale, so the
   * latest order state is fetched and the alert dismissed instead of retried.
   * Returns false when the decision belonged to someone else.
   *
   * `preparationMinutes` comes only from the popup stepper of a food order; the
   * server owns the deadline either way.
   */
  const settleDecision = useCallback(
    async (
      orderId: string,
      outcome: 'ACCEPTED' | 'REJECTED',
      preparationMinutes?: number,
    ): Promise<boolean> => {
      try {
        if (outcome === 'ACCEPTED') {
          await acceptOrder(orderId, preparationMinutes);
        } else {
          await rejectOrder(orderId);
        }
        applyOrderDecision(orderId, outcome);
        showSuccess(
          outcome === 'ACCEPTED'
            ? 'Order accepted successfully'
            : 'Order rejected successfully',
        );
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          console.log(
            `[ORDER-ACTION] 409 — order ${orderId} already decided elsewhere`,
          );
          await dismissStaleAlert(orderId);
          showError('This order was already handled on another device');
          return false;
        }
        throw err;
      }
    },
    [acceptOrder, rejectOrder, showSuccess, showError],
  );

  // Register notification action handler (ACCEPT/REJECT from notification buttons)
  useEffect(() => {
    setNotificationActionHandler(async ({ action, orderId }) => {
      const outcome = action === 'ORDER_ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      console.log(`[ORDER-ACTION] ${outcome} from notification`);
      try {
        await settleDecision(orderId, outcome);
      } catch (err) {
        // The decision never reached the backend. settleDecision already closed
        // the alert for 2xx and for a 409; anything else (offline, expired
        // session, server error) must leave the alert in place as the retry
        // point, and say why — never a silent swallow.
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          `[ORDER-ACTION] ${outcome} for order ${orderId} NOT sent: ${message}`,
        );
        showError(
          `Could not ${outcome === 'ACCEPTED' ? 'accept' : 'reject'} order ${orderId}: ${message}`,
        );
      }
    });
    return () => removeNotificationActionHandler();
  }, [settleDecision, showError]);


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

  // One clock for the whole visible list. Each card still computes
  // `preparationDueAt - now`, so this interval only decides how often the text
  // repaints — it cannot drift, and it stops when nothing on screen has a timer.
  const [prepNow, setPrepNow] = useState(() => Date.now());
  const anyPrepTimer = filteredOrders.some(showsPreparationTimer);
  useEffect(() => {
    if (!anyPrepTimer) return;
    // Resync on entering a tab with timers: the state may have been set a while
    // ago while the screen was on another tab or backgrounded.
    setPrepNow(Date.now());
    const id = setInterval(() => setPrepNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyPrepTimer]);

  // Horizontal swipe between tabs (right→left = next, left→right = previous)
  const swipeTabBy = useCallback(
    (dir: 1 | -1) => {
      const index = FIXED_TABS.findIndex(t => t.key === activeTab);
      const target = FIXED_TABS[index + dir];
      if (!target) return;
      setActiveTab(target.key);
    },
    [activeTab],
  );
  const swipeTabRef = useRef(swipeTabBy);
  swipeTabRef.current = swipeTabBy;

  const listSwipePan = useRef(
    PanResponder.create({
      // Claim only clearly horizontal drags so vertical list scrolling and
      // pull-to-refresh are untouched
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_e, g) => {
        const SWIPE_THRESHOLD = 50;
        if (g.dx <= -SWIPE_THRESHOLD) {
          swipeTabRef.current(1);
        } else if (g.dx >= SWIPE_THRESHOLD) {
          swipeTabRef.current(-1);
        }
      },
    }),
  ).current;

  // Modal actions — one decision path for the modal, the cards and the
  // notification buttons, so cross-device cleanup can never be half-implemented
  const handleModalAccept = useCallback(
    async (orderId: string, preparationMinutes?: number) => {
      try {
        console.log('[ORDER-ACTION] ACCEPT via modal');
        await settleDecision(orderId, 'ACCEPTED', preparationMinutes);
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
    [settleDecision],
  );

  const handleModalReject = useCallback(
    async (orderId: string) => {
      setRejectingId(orderId);
      try {
        console.log('[ORDER-ACTION] REJECT via modal');
        await settleDecision(orderId, 'REJECTED');
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
    [settleDecision],
  );

  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Image
            source={require('../assets/logo_square.png')}
            style={styles.headerLogoImage}
          />
        </View>
        <View style={styles.headerRight}>
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

      {/* Order List — horizontal swipe switches tabs */}
      <View style={styles.listSwipeArea} {...listSwipePan.panHandlers}>
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
                  prepNow={prepNow}
                  isAccepting={acceptingId === item.id}
                  onAccept={async (orderId, preparationMinutes) => {
                    setAcceptingId(orderId);
                    try {
                      await settleDecision(
                        orderId,
                        'ACCEPTED',
                        preparationMinutes,
                      );
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
                      await settleDecision(orderId, 'REJECTED');
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
      </View>

      {/* New Order Alert — same decisions as the pending card below it */}
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
  headerLogoImage: {
    width: 36,
    height: 36,
    borderRadius: 10,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  listSwipeArea: {
    flex: 1,
  },

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
