/**
 * Food order preparation timer.
 *
 *   npx jest __tests__/food-preparation-timer.test.tsx
 *
 * The 12 required cases:
 *   1  food popup defaults to 30                     → 'popup stepper'
 *   2  increment / decrement by 1                    → 'popup stepper'
 *   3  minimum 1                                     → 'popup stepper'
 *   4  maximum 45                                    → 'popup stepper'
 *   5  non-food order hides the selector             → 'popup stepper'
 *   6  the timer starts only after acceptance        → 'deadline ownership'
 *   7  accurate after an app restart                 → 'countdown from the deadline'
 *   8  every device shows the same due time          → 'countdown from the deadline'
 *   9  red / late at the deadline                    → 'countdown from the deadline'
 *   10 overtime keeps growing                        → 'countdown from the deadline'
 *   11 a completed order stops the timer             → 'terminal statuses'
 *   12 a concurrent accept cannot reset the deadline → 'deadline ownership'
 *
 *   Phase 6 — the countdown belongs to Processing only:
 *   P1/P2 processing keeps counting (and goes red late)  → 'the frozen … duration'
 *   P3-P5 leaving Processing freezes the actual duration → 'the frozen … duration'
 *   P6/P7 restart and multi-device invariance            → 'the frozen … duration'
 *   P8 an absent server timestamp invents nothing        → 'the frozen … duration'
 *   P9 non-food orders unaffected                        → 'the frozen … duration'
 *   P10 the accept race stays server-owned               → 'the frozen … duration'
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';
import { Colors } from '../src/theme/colors';

/* ── The popup plays a looping siren through the native bridge — out of scope
 *    for these tests, and it must not be touched by a render. */
var mockStartOrderAlertSound = jest.fn();
var mockStopOrderAlertSound = jest.fn();
jest.mock('../src/services/sound.service', () => ({
  startOrderAlertSound: (...args: unknown[]) => mockStartOrderAlertSound(...args),
  stopOrderAlertSound: (...args: unknown[]) => mockStopOrderAlertSound(...args),
}));

/* ── REST layer: the tests assert exactly what a device puts on the wire and
 *    what it does with what the server answers. */
var mockApiPut = jest.fn(async (_path: string, _body: unknown) => ({} as unknown));
var mockApiGet = jest.fn(async (_path: string) => ([] as unknown));
jest.mock('../src/services/api.client', () => ({
  apiPut: (path: string, body: unknown) => mockApiPut(path, body),
  apiGet: (path: string) => mockApiGet(path),
  apiPost: jest.fn(async () => ({})),
  ApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { NewOrderAlertModal } from '../src/components/NewOrderAlertModal';
import { OrderCard } from '../src/components/OrderCard';
import { acceptOrder, getOrders } from '../src/services/order.service';
import {
  buildOrderFromNotification,
  mergeAlertOrder,
  parseItemsJson,
} from '../src/services/pushOrder';
import {
  PREP_DEFAULT_MINUTES,
  PREP_MAX_MINUTES,
  PREP_MIN_MINUTES,
  clampPreparationMinutes,
  formatPreparationCountdown,
  formatPreparationDuration,
  isFoodItem,
  isFoodOrder,
  preparationDueMs,
  preparationLabel,
  preparationSummary,
  serverPreparationTimer,
  showsPreparationTimer,
} from '../src/services/prepTimer';
import type { Order, OrderItem, PreparationTimerPatch } from '../src/types';

/* ── Fixtures ────────────────────────────────────────────────────────── */

const DUE = '2026-09-30T10:25:00.000Z';
const DUE_MS = Date.parse(DUE);

function foodOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    orderNumber: '1001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    deliveryAddress: 'Somewhere',
    items: [
      {
        id: 'i1',
        name: 'Paneer Curry',
        quantity: 1,
        price: 250,
        total: 250,
        ready: false,
        cancelled: false,
        itemType: 'food',
      },
    ],
    status: 'pending',
    subtotal: 250,
    discount: 0,
    deliveryCharge: 0,
    tax: 0,
    grandTotal: 250,
    createdAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

function nonFoodOrder(): Order {
  return foodOrder({
    items: [
      {
        id: 'i2',
        name: 'Ghee Jar',
        quantity: 1,
        price: 500,
        total: 500,
        ready: false,
        cancelled: false,
        itemType: 'product',
      },
    ],
  });
}

/** A raw API row, exactly as GET /api/orders returns it (snake_case). */
function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    user_id: 'u1',
    order_number: '1001',
    status: 'confirmed',
    subtotal: 250,
    discount: 0,
    shipping: 0,
    tax: 0,
    total: 250,
    coupon_code: null,
    payment_method: 'cod',
    payment_status: 'pending',
    address: { line1: 'Somewhere' },
    notes: null,
    has_food: true,
    created_at: '2026-09-30T10:00:00.000Z',
    updated_at: '2026-09-30T10:05:00.000Z',
    user: { id: 'u1', name: 'Test Customer', phone: '9999999999' },
    order_items: [
      {
        id: 'i1',
        product_name: 'Paneer Curry',
        quantity: 1,
        unit_price: 250,
        total: 250,
        item_type: 'food',
      },
    ],
    ...overrides,
  };
}

/* ── Render helpers ──────────────────────────────────────────────────── */

/** Every mounted tree, torn down after each test. The alert modal runs a
 *  looping Animated pulse, so a tree left mounted keeps scheduling timers past
 *  the test that created it. */
const mounted: Array<ReturnType<typeof create>> = [];

function track<T extends ReturnType<typeof create>>(tree: T): T {
  mounted.push(tree);
  return tree;
}

afterEach(() => {
  while (mounted.length > 0) {
    const tree = mounted.pop()!;
    act(() => {
      tree.unmount();
    });
  }
});

async function mountModal(order: Order, onAccept = jest.fn()) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = track(
      create(
        <NewOrderAlertModal
          visible
          order={order}
          onAccept={onAccept}
          onReject={jest.fn()}
        />,
      ),
    );
  });
  await act(async () => {});
  return tree;
}

/** Host text node like `30 min` — the stepper's current value. */
function stepperValue(tree: ReturnType<typeof create>): string | null {
  const node = tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      /^\d+ min$/.test(n.children.flat().map(String).join('')),
  )[0];
  return node ? node.children.flat().map(String).join('') : null;
}

function stepButton(tree: ReturnType<typeof create>, testId: string) {
  return tree.root.findAll(
    n =>
      n.props?.testID === testId &&
      typeof n.props?.onPress === 'function',
  )[0];
}

async function press(tree: ReturnType<typeof create>, testId: string, times = 1) {
  for (let i = 0; i < times; i += 1) {
    const button = stepButton(tree, testId);
    await act(async () => {
      button.props.onPress();
    });
  }
  await act(async () => {});
}

const minutes = (value: number) => `${value} min`;

/* ── 1-5: the popup selector ─────────────────────────────────────────── */

describe('popup stepper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1 — a food order starts at the 30 minute default', async () => {
    const tree = await mountModal(foodOrder());
    expect(stepperValue(tree)).toBe(minutes(PREP_DEFAULT_MINUTES));
  });

  it('2 — plus and minus move by exactly one minute', async () => {
    const tree = await mountModal(foodOrder());

    await press(tree, 'prep-plus');
    expect(stepperValue(tree)).toBe(minutes(31));

    await press(tree, 'prep-plus', 2);
    expect(stepperValue(tree)).toBe(minutes(33));

    await press(tree, 'prep-minus');
    expect(stepperValue(tree)).toBe(minutes(32));
  });

  it('3 — one minute is the floor: the minus button is disabled and cannot go lower', async () => {
    const tree = await mountModal(foodOrder());

    await press(tree, 'prep-minus', PREP_DEFAULT_MINUTES - PREP_MIN_MINUTES);
    expect(stepperValue(tree)).toBe(minutes(PREP_MIN_MINUTES));
    expect(stepButton(tree, 'prep-minus').props.disabled).toBe(true);

    // A press that reaches the handler anyway (e.g. a stale tap during a
    // re-render) is clamped, so the value cannot leak below the minimum.
    await act(async () => {
      stepButton(tree, 'prep-minus').props.onPress();
    });
    await act(async () => {});
    expect(stepperValue(tree)).toBe(minutes(PREP_MIN_MINUTES));
  });

  it('4 — 45 minutes is the ceiling: the plus button is disabled', async () => {
    const tree = await mountModal(foodOrder());

    await press(tree, 'prep-plus', PREP_MAX_MINUTES - PREP_DEFAULT_MINUTES);
    expect(stepperValue(tree)).toBe(minutes(PREP_MAX_MINUTES));
    expect(stepButton(tree, 'prep-plus').props.disabled).toBe(true);
    expect(stepButton(tree, 'prep-minus').props.disabled).toBe(false);
  });

  it('5 — a non-food order shows no selector at all', async () => {
    const tree = await mountModal(nonFoodOrder());

    expect(stepperValue(tree)).toBeNull();
    expect(stepButton(tree, 'prep-plus')).toBeUndefined();
    expect(stepButton(tree, 'prep-minus')).toBeUndefined();
    // The existing actions are untouched.
    expect(acceptLabelExists(tree)).toBe(true);
  });

  it('5b — accepting a non-food order sends no preparation time', async () => {
    const onAccept = jest.fn();
    const tree = await mountModal(nonFoodOrder(), onAccept);

    await act(async () => {
      stepAccept(tree)!.props.onPress();
    });

    expect(onAccept).toHaveBeenCalledWith('order-1', undefined);
  });

  it('5c — accepting a food order sends the selected minutes', async () => {
    const onAccept = jest.fn();
    const tree = await mountModal(foodOrder(), onAccept);

    await press(tree, 'prep-plus', 5);
    await act(async () => {
      stepAccept(tree)!.props.onPress();
    });

    expect(onAccept).toHaveBeenCalledWith('order-1', 35);
  });

  it('1b — a second order replacing the open popup resets the default', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = track(
        create(
          <NewOrderAlertModal
            visible
            order={foodOrder()}
            onAccept={jest.fn()}
            onReject={jest.fn()}
          />,
        ),
      );
    });
    await act(async () => {});

    await press(tree, 'prep-plus', 3);
    expect(stepperValue(tree)).toBe(minutes(33));

    // No close/reopen: only the order changes underneath.
    await act(async () => {
      tree.update(
        <NewOrderAlertModal
          visible
          order={foodOrder({ id: 'order-2', orderNumber: '1002' })}
          onAccept={jest.fn()}
          onReject={jest.fn()}
        />,
      );
    });
    await act(async () => {});

    expect(stepperValue(tree)).toBe(minutes(PREP_DEFAULT_MINUTES));
  });

  it('6 — opening the popup starts no timer: nothing is accepted and no deadline exists', async () => {
    const order = foodOrder();
    const tree = await mountModal(order);

    expect(isFoodOrder(order)).toBe(true);
    expect(preparationDueMs(order)).toBeNull();
    expect(showsPreparationTimer(order)).toBe(false);
    // The popup alone only ever rings the alert; it never decides the order.
    expect(mockApiPut).not.toHaveBeenCalled();
    expect(tree).toBeDefined();
  });
});

/**
 * The Accept control: walk up from the host `Accept` label to the ancestor that
 * actually owns `onPress` — the Pressable's own children are elements, not text.
 */
function stepAccept(tree: ReturnType<typeof create>) {
  const label = tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.children.flat().map(String).join('') === 'Accept',
  )[0];
  if (!label) return undefined;
  let node: typeof label.parent = label.parent;
  while (node && typeof node.props?.onPress !== 'function') {
    node = node.parent;
  }
  return node;
}

function acceptLabelExists(tree: ReturnType<typeof create>): boolean {
  return (
    tree.root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.children.flat().map(String).join('') === 'Accept',
    ).length > 0
  );
}

/** Mount a card on the shared clock so the countdown is deterministic. */
async function mountCard(order: Order, prepNow: number) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = track(create(<OrderCard order={order} prepNow={prepNow} />));
  });
  return tree;
}

function hostTexts(tree: ReturnType<typeof create>): string[] {
  return tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n => n.children.flat().map(String).join(''));
}

/* ── The device's request versus the server's deadline ───────────────── */

describe('deadline ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('6b — the accept call is the only thing that carries the selection', async () => {
    await acceptOrder('order-1', 25);

    expect(mockApiPut).toHaveBeenCalledWith('/api/orders/order-1', {
      status: 'confirmed',
      preparation_time_minutes: 25,
    });
  });

  it('6c — a card accept with no selector sends no preparation field at all', async () => {
    await acceptOrder('order-1');

    expect(mockApiPut).toHaveBeenCalledWith('/api/orders/order-1', {
      status: 'confirmed',
    });
  });

  it('6d — a failed accept leaves the order without a deadline', async () => {
    mockApiPut.mockRejectedValueOnce(new Error('offline'));

    await expect(acceptOrder('order-1', 20)).rejects.toThrow('offline');
    // Nothing locally stamped the timer: a pending order still has no due time.
    expect(showsPreparationTimer(foodOrder())).toBe(false);
  });

  it('12 — the deadline shown is the server answer, not this device wish', async () => {
    /* The losing device asked for 5 minutes; the winner stored 25. The row that
     * arrives back from GET /api/orders carries the winner's instant, and that
     * is the only input the countdown has — there is no local selection to fall
     * back on, so a concurrent accept cannot move the deadline. */
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        preparation_time_minutes: 25,
        accepted_at: '2026-09-30T10:00:00.000Z',
        preparation_due_at: DUE,
      }),
    ]);

    const [order] = await getOrders();

    expect(order.preparationTimeMinutes).toBe(25);
    expect(order.preparationDueAt).toBe(DUE);
    expect(formatPreparationCountdown(DUE_MS, DUE_MS - 600_000)).toEqual({
      label: '10:00',
      late: false,
    });
    expect(preparationDueMs(order)).toBe(DUE_MS);
  });
});

/* ── 7-10: the countdown itself ─────────────────────────────────────── */

describe('countdown from the deadline', () => {
  it('7 — a restart ten minutes later resumes from the stored instant, not from 30', async () => {
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        preparation_time_minutes: 30,
        accepted_at: '2026-09-30T10:00:00.000Z',
        preparation_due_at: DUE,
      }),
    ]);
    const [order] = await getOrders();
    const dueMs = preparationDueMs(order)!;

    // Accepted at 10:00 for 25 minutes; the app is reopened at 10:20.
    const remainingMs = dueMs - Date.parse('2026-09-30T10:20:00.000Z');
    expect(remainingMs).toBe(5 * 60_000);
    expect(formatPreparationCountdown(dueMs, Date.parse('2026-09-30T10:20:00.000Z')))
      .toEqual({ label: '05:00', late: false });
  });

  it('8 — two devices that fetched the same row compute the same remaining time', async () => {
    const row = rawOrder({ preparation_due_at: DUE });
    mockApiGet.mockResolvedValueOnce([row, row]);
    const [phoneA, phoneB] = await getOrders();

    const now = Date.parse('2026-09-30T10:10:00.000Z');
    expect(phoneA.preparationDueAt).toBe(phoneB.preparationDueAt);
    expect(formatPreparationCountdown(preparationDueMs(phoneA)!, now)).toEqual(
      formatPreparationCountdown(preparationDueMs(phoneB)!, now),
    );
    expect(formatPreparationCountdown(preparationDueMs(phoneA)!, now).label).toBe(
      '15:00',
    );
  });

  it('9 — at exactly the deadline the order is already late and red', () => {
    expect(formatPreparationCountdown(DUE_MS, DUE_MS)).toEqual({
      label: '+00:00',
      late: true,
    });
    expect(formatPreparationCountdown(DUE_MS, DUE_MS - 1)).toEqual({
      label: '00:00',
      late: false,
    });
  });

  it('10 — overtime keeps growing, in MM:SS then HH:MM:SS', () => {
    expect(formatPreparationCountdown(DUE_MS, DUE_MS + 90_000).label).toBe('+01:30');
    expect(formatPreparationCountdown(DUE_MS, DUE_MS + 3_600_000).label).toBe(
      '+01:00:00',
    );
    expect(formatPreparationCountdown(DUE_MS, DUE_MS + 7_325_000).label).toBe(
      '+02:02:05',
    );
    expect(formatPreparationCountdown(DUE_MS, DUE_MS + 7_325_000).late).toBe(true);
  });

  it('10b — remaining time switches to HH:MM:SS only past an hour', () => {
    const far = DUE_MS + 3_750_000;
    expect(formatPreparationCountdown(far, DUE_MS).label).toBe('01:02:30');
    expect(formatPreparationCountdown(DUE_MS + 600_000, DUE_MS).label).toBe('10:00');
  });

  it('a missing or unreadable deadline never produces a countdown', () => {
    expect(preparationDueMs(foodOrder())).toBeNull();
    expect(preparationDueMs(foodOrder({ preparationDueAt: 'not a date' }))).toBeNull();
    expect(showsPreparationTimer(foodOrder({ preparationDueAt: 'not a date' }))).toBe(
      false,
    );
  });

  it('the clamp matches the selector bounds', () => {
    expect(clampPreparationMinutes(undefined)).toBe(PREP_DEFAULT_MINUTES);
    expect(clampPreparationMinutes('abc')).toBe(PREP_DEFAULT_MINUTES);
    expect(clampPreparationMinutes(0)).toBe(PREP_MIN_MINUTES);
    expect(clampPreparationMinutes(-5)).toBe(PREP_MIN_MINUTES);
    expect(clampPreparationMinutes(999)).toBe(PREP_MAX_MINUTES);
    expect(clampPreparationMinutes(25.4)).toBe(25);
  });
});

/* ── 11: terminal statuses ──────────────────────────────────────────── */

describe('terminal statuses stop the timer', () => {
  const accepted = {
    preparationDueAt: DUE,
    preparationTimeMinutes: 25,
    acceptedAt: '2026-09-30T10:00:00.000Z',
  };

  it.each(['confirmed', 'processing', 'packed'] as const)(
    '%s is still owed kitchen time',
    status => {
      expect(showsPreparationTimer(foodOrder({ status: status as Order['status'], ...accepted }))).toBe(
        true,
      );
    },
  );

  it.each(['shipped', 'delivered', 'cancelled', 'refunded'] as const)(
    '%s ends the countdown without ending the order automatically',
    status => {
      const order = foodOrder({
        status: status as Order['status'],
        ...accepted,
      });
      expect(showsPreparationTimer(order)).toBe(false);
    },
  );

  it('an overtime order keeps counting while it is still processing', async () => {
    const order = foodOrder({ status: 'processing', ...accepted });
    const card = await mountCard(order, DUE_MS + 120_000);

    const texts = hostTexts(card);
    expect(texts).toContain('+02:00');
    expect(texts).toContain('Late by');
    expect(texts).toContain('Late');
  });

  it('a non-food order as the API returns it renders no timer row', async () => {
    /* Feature 5 holds at the data level: the backend stores a deadline only for
     * an order with an active food item, so a non-food order arrives with none
     * and the card has nothing to count down from. */
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        has_food: false,
        order_items: [
          {
            id: 'i2',
            product_name: 'Ghee Jar',
            quantity: 1,
            unit_price: 500,
            total: 500,
            item_type: 'product',
          },
        ],
      }),
    ]);
    const [order] = await getOrders();

    expect(order.preparationDueAt).toBeUndefined();
    expect(isFoodOrder(order)).toBe(false);
    expect(showsPreparationTimer(order)).toBe(false);

    const card = await mountCard(order, DUE_MS - 600_000);
    const texts = hostTexts(card);
    expect(texts).not.toContain('Ready in');
    expect(texts).not.toContain('Late by');
    expect(texts).not.toContain('Late');
    expect(texts).not.toContain('10:00');
  });
});

/* ── 1, 5: the same rules for an order that only ever arrived as a push ─ */

describe('an order built from the NEW_ORDER push', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Mirrors the backend's `payloadItems`: camelCase, every scalar a string
   *  except the numbers FCM already carries inside the JSON blob. */
  const pushOrderData = {
    orderId: 'order-1',
    orderNumber: '1001',
    customerName: 'Test Customer',
    customerPhone: '9999999999',
    address: 'Somewhere',
    itemCount: '1',
    total: '250',
    paymentMethod: 'cod',
    paymentStatus: 'pending',
  };

  function pushItems(itemType: string | undefined): string {
    return JSON.stringify([
      {
        id: 'i1',
        itemId: 'i1',
        name: 'Paneer Curry',
        quantity: 1,
        price: 250,
        unitPrice: 250,
        total: 250,
        image: '',
        ...(itemType === undefined ? {} : { itemType }),
      },
    ]);
  }

  it('1c — a food push shows the selector even though no API row was fetched', async () => {
    const order = buildOrderFromNotification({
      ...pushOrderData,
      items: pushItems('food'),
    });

    expect(isFoodOrder(order)).toBe(true);
    const onAccept = jest.fn();
    const tree = await mountModal(order, onAccept);
    expect(stepperValue(tree)).toBe(minutes(PREP_DEFAULT_MINUTES));

    await press(tree, 'prep-minus', 5);
    await act(async () => {
      stepAccept(tree)!.props.onPress();
    });
    expect(onAccept).toHaveBeenCalledWith('order-1', 25);
  });

  it('5e — a product push shows no selector', async () => {
    const order = buildOrderFromNotification({
      ...pushOrderData,
      items: pushItems('product'),
    });

    expect(isFoodOrder(order)).toBe(false);
    const tree = await mountModal(order);
    expect(stepperValue(tree)).toBeNull();
  });

  it('5f — a push from an older backend (no itemType) is treated as non-food', async () => {
    const order = buildOrderFromNotification({
      ...pushOrderData,
      items: pushItems(undefined),
    });

    expect(isFoodOrder(order)).toBe(false);
    const tree = await mountModal(order);
    expect(stepperValue(tree)).toBeNull();
  });

  it('items keep their type whichever naming the payload uses', () => {
    expect(parseItemsJson(pushItems('food'))[0].itemType).toBe('food');
    expect(
      parseItemsJson(
        JSON.stringify([{ id: 'i1', name: 'Paneer Curry', quantity: 1, item_type: 'food' }]),
      )[0].itemType,
    ).toBe('food');
    expect(parseItemsJson('not json')).toEqual([]);
  });
});

/* ── Requirement 2: both backend fields, never the product name ──────── */

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'i1',
    name: 'Chili Paneer Momo [5 Piece]',
    quantity: 1,
    price: 250,
    total: 250,
    ready: false,
    cancelled: false,
    ...overrides,
  };
}

describe('food detection from the backend fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('2a — item_type alone marks the order as cookable', async () => {
    const order = foodOrder({ items: [item({ itemType: 'food' })] });
    expect(isFoodItem(order.items[0])).toBe(true);
    const tree = await mountModal(order);
    expect(hostTexts(tree)).toContain('Making Time');
    expect(stepperValue(tree)).toBe(minutes(PREP_DEFAULT_MINUTES));
  });

  it('2b — product.product_type alone marks it, when item_type says product', async () => {
    const order = foodOrder({
      items: [item({ itemType: 'product', productType: 'food' })],
    });
    expect(isFoodItem(order.items[0])).toBe(true);
    const tree = await mountModal(order);
    expect(stepperValue(tree)).toBe(minutes(PREP_DEFAULT_MINUTES));
  });

  it('2c — neither field food means no selector, whatever the item is called', async () => {
    // The name is literally a dish; only the two backend fields decide.
    const order = foodOrder({
      items: [item({ itemType: 'product', productType: 'product' })],
    });
    expect(isFoodOrder(order)).toBe(false);
    const tree = await mountModal(order);
    expect(hostTexts(tree)).not.toContain('Making Time');
    expect(stepperValue(tree)).toBeNull();
    expect(acceptLabelExists(tree)).toBe(true);
  });

  it('2d — a cancelled food item does not make the order cookable', () => {
    expect(isFoodItem(item({ itemType: 'food', cancelled: true }))).toBe(false);
    // …but a live one alongside a cancelled product item still does.
    expect(
      isFoodOrder(
        foodOrder({
          items: [
            item({ id: 'i1', itemType: 'food', cancelled: true }),
            item({ id: 'i2', itemType: 'product', productType: 'food' }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('2e — the marker is compared as a trimmed, case-insensitive word', () => {
    expect(isFoodItem(item({ itemType: ' FOOD ' }))).toBe(true);
    expect(isFoodItem(item({ itemType: 'food-plate' }))).toBe(false);
    expect(isFoodItem(item({ itemType: null as unknown as string }))).toBe(false);
    expect(isFoodItem(item({ productType: undefined }))).toBe(false);
  });

  it('2f — the API row carries both fields through the mapper', async () => {
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        status: 'pending',
        order_items: [
          {
            id: 'i1',
            product_name: 'Chili Paneer Momo [5 Piece]',
            quantity: 1,
            unit_price: 250,
            total: 250,
            item_type: 'product',
            product: { product_type: 'food' },
          },
        ],
      }),
    ]);
    const [order] = await getOrders();

    expect(order.items[0].itemType).toBe('product');
    expect(order.items[0].productType).toBe('food');
    expect(isFoodOrder(order)).toBe(true);

    const tree = await mountModal(order);
    expect(hostTexts(tree)).toContain('Making Time');
  });

  it('2g — an item with no linked product record still reads safely', () => {
    const order = foodOrder({ items: [item({ itemType: 'puja' })] });
    expect(isFoodOrder(order)).toBe(false);
  });
});

/* ── Requirement 1/10: one selector state per order ──────────────────── */

describe('each order keeps its own selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('10 — selecting on one order leaves another order at the default', async () => {
    const first = await mountModal(foodOrder({ id: 'order-a', orderNumber: '1001' }));
    const second = await mountModal(foodOrder({ id: 'order-b', orderNumber: '1002' }));

    await press(first, 'prep-plus');
    expect(stepperValue(first)).toBe(minutes(31));
    expect(stepperValue(second)).toBe(minutes(PREP_DEFAULT_MINUTES));

    await press(second, 'prep-minus', 2);
    expect(stepperValue(second)).toBe(minutes(28));
    expect(stepperValue(first)).toBe(minutes(31));
  });

  it('5 — decrementing from the default is one minute, not five', async () => {
    const tree = await mountModal(foodOrder());
    await press(tree, 'prep-minus');
    expect(stepperValue(tree)).toBe(minutes(29));
  });

  it('1e — Accept and Reject are still there next to the selector', async () => {
    const tree = await mountModal(foodOrder());
    expect(hostTexts(tree)).toContain('Making Time');
    expect(acceptLabelExists(tree)).toBe(true);
    expect(
      tree.root.findAll(
        n => typeof n.type === 'string' && n.children.flat().map(String).join('') === 'Reject',
      ).length,
    ).toBeGreaterThan(0);
  });
});

/* ── Requirement 4/5: the alert works off the real order record ──────── */

describe('the alert order re-read from the API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function pushedWithoutMarkers(): Order {
    return buildOrderFromNotification({
      orderId: 'order-1',
      orderNumber: '1001',
      customerName: 'Test Customer',
      itemCount: '1',
      total: '250',
      items: JSON.stringify([
        { id: 'i1', name: 'Chili Paneer Momo [5 Piece]', quantity: 1, price: 250, total: 250 },
      ]),
    });
  }

  it('4 — a payload with no markers becomes a food order once the row is read', async () => {
    const pushed = pushedWithoutMarkers();
    expect(isFoodOrder(pushed)).toBe(false);

    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        status: 'pending',
        order_items: [
          {
            id: 'i1',
            product_name: 'Chili Paneer Momo [5 Piece]',
            quantity: 1,
            unit_price: 250,
            total: 250,
            item_type: 'food',
            product: { product_type: 'food' },
          },
        ],
      }),
    ]);
    const [fresh] = await getOrders();
    const merged = mergeAlertOrder(pushed, fresh);

    expect(isFoodOrder(merged!)).toBe(true);
    const tree = await mountModal(merged!);
    expect(hostTexts(tree)).toContain('Making Time');
  });

  it('5g — the re-read takes the row content but not a new status', async () => {
    const pushed = pushedWithoutMarkers();
    mockApiGet.mockResolvedValueOnce([rawOrder({ status: 'confirmed' })]);
    const [fresh] = await getOrders();
    const merged = mergeAlertOrder(pushed, fresh)!;

    // Status logic belongs to orderAlertSync, not to this refresh.
    expect(fresh.status).toBe('confirmed');
    expect(merged.status).toBe('pending');
    expect(merged.customerName).toBe(fresh.customerName);
    expect(merged.items).toEqual(fresh.items);
  });

  it('11 — a late read cannot reopen a modal another device already closed', () => {
    const pushed = pushedWithoutMarkers();
    // Dismissed by ORDER_STATUS_UPDATED before the fetch resolved.
    expect(mergeAlertOrder(null, pushed)).toBeNull();
    // …and it never describes a different order either.
    const other = foodOrder({ id: 'order-z' });
    expect(mergeAlertOrder(pushed, other)).toBe(pushed);
    expect(mergeAlertOrder(pushed, null)).toBe(pushed);
  });
});

/* ── The pending order card: the other accept surface ──────────────────
 *
 * The popup only appears with a push, so a vendor who opens the app on a
 * pending order decides from the card in the New Order tab. That card has to
 * carry the same selector, otherwise the making time is unreachable — which is
 * exactly what the field screenshot showed.
 */

/** The row behind that screenshot: pending, both food markers set. */
const MOMO_ROW = {
  id: 'order-momo',
  status: 'pending',
  order_items: [
    {
      id: 'i1',
      product_name: 'Chicken Kurkure Momo',
      quantity: 1,
      unit_price: 180,
      total: 180,
      item_type: 'food',
      product: { product_type: 'food' },
    },
  ],
};

/** Reads the real API shape through the real mapper, like the screen does. */
async function momoOrderFromApi(): Promise<Order> {
  mockApiGet.mockResolvedValueOnce([rawOrder(MOMO_ROW)]);
  const [order] = await getOrders();
  return order;
}

async function mountDecisionCard(order: Order, prepNow?: number) {
  const onAccept = jest.fn();
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = track(
      create(
        <OrderCard
          order={order}
          prepNow={prepNow}
          onAccept={onAccept}
          onReject={jest.fn()}
        />,
      ),
    );
  });
  return { tree, onAccept };
}

async function tapAccept(tree: ReturnType<typeof create>) {
  await act(async () => {
    stepAccept(tree)!.props.onPress();
  });
  await act(async () => {});
}

describe('the pending order card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('C1 — Making Time renders above Accept/Reject for the real food order', async () => {
    const order = await momoOrderFromApi();
    expect(order.status).toBe('pending');
    expect(order.items[0].itemType).toBe('food');
    expect(order.items[0].productType).toBe('food');
    expect(isFoodOrder(order)).toBe(true);

    const { tree } = await mountDecisionCard(order);
    const texts = hostTexts(tree);

    expect(texts).toContain('Making Time');
    expect(texts).toContain(minutes(PREP_DEFAULT_MINUTES));
    expect(texts).toContain('Accept');
    expect(texts).toContain('Reject');
    expect(stepButton(tree, 'prep-minus')).toBeDefined();
    expect(stepButton(tree, 'prep-plus')).toBeDefined();
    // Immediately above the buttons: selector, then Accept, then Reject.
    expect(texts.indexOf('Making Time')).toBeLessThan(texts.indexOf('Accept'));
    expect(texts.indexOf('Accept')).toBeLessThan(texts.indexOf('Reject'));
  });

  it('C2 — plus and minus on the card move by exactly one minute', async () => {
    const { tree } = await mountDecisionCard(await momoOrderFromApi());

    await press(tree, 'prep-plus');
    expect(stepperValue(tree)).toBe(minutes(31));

    await press(tree, 'prep-minus', 2);
    expect(stepperValue(tree)).toBe(minutes(29));
  });

  it('C3 — the card clamps at 45 and at 1 and disables the bound button', async () => {
    const { tree } = await mountDecisionCard(await momoOrderFromApi());

    await press(tree, 'prep-plus', PREP_MAX_MINUTES - PREP_DEFAULT_MINUTES);
    expect(stepperValue(tree)).toBe(minutes(PREP_MAX_MINUTES));
    expect(stepButton(tree, 'prep-plus').props.disabled).toBe(true);

    await press(tree, 'prep-minus', PREP_MAX_MINUTES - PREP_MIN_MINUTES);
    expect(stepperValue(tree)).toBe(minutes(PREP_MIN_MINUTES));
    expect(stepButton(tree, 'prep-minus').props.disabled).toBe(true);
  });

  it('C4 — accepting from the card sends the selection', async () => {
    const { tree, onAccept } = await mountDecisionCard(await momoOrderFromApi());

    await press(tree, 'prep-plus', 5);
    await tapAccept(tree);

    expect(onAccept).toHaveBeenCalledWith('order-momo', 35);
  });

  it('C5 — a product order keeps the buttons and shows no selector', async () => {
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        id: 'order-momo',
        status: 'pending',
        order_items: [
          {
            id: 'i1',
            product_name: 'Ghee Jar',
            quantity: 1,
            unit_price: 500,
            total: 500,
            item_type: 'product',
            product: { product_type: 'product' },
          },
        ],
      }),
    ]);
    const [order] = await getOrders();
    const { tree, onAccept } = await mountDecisionCard(order);

    expect(hostTexts(tree)).not.toContain('Making Time');
    expect(stepperValue(tree)).toBeNull();
    expect(acceptLabelExists(tree)).toBe(true);

    await tapAccept(tree);
    expect(onAccept).toHaveBeenCalledWith('order-momo', undefined);
  });

  it('C6 — only a pending card offers the choice: accepted food orders show the countdown', async () => {
    const accepted = await momoOrderFromApi();
    const card = await mountDecisionCard(
      {
        ...accepted,
        status: 'confirmed',
        preparationTimeMinutes: 25,
        acceptedAt: '2026-09-30T10:00:00.000Z',
        preparationDueAt: DUE,
      },
      DUE_MS - 600_000,
    );

    expect(hostTexts(card.tree)).not.toContain('Making Time');
    expect(stepperValue(card.tree)).toBeNull();
    // The countdown took its place, on the same deadline the server stored.
    const timer = hostTexts(card.tree);
    expect(timer).toContain('Ready in');
    expect(timer).toContain('10:00');
  });

  it('C7 — a card rendered without decision handlers shows no selector', async () => {
    const tree = await mountCard(await momoOrderFromApi(), DUE_MS);

    expect(hostTexts(tree)).not.toContain('Making Time');
    expect(stepperValue(tree)).toBeNull();
  });

  it('C8 — two pending cards keep independent selections', async () => {
    const first = await mountDecisionCard(
      await momoOrderFromApi(),
    );
    const second = await mountDecisionCard(await momoOrderFromApi());

    await press(first.tree, 'prep-plus', 3);
    expect(stepperValue(first.tree)).toBe(minutes(33));
    expect(stepperValue(second.tree)).toBe(minutes(PREP_DEFAULT_MINUTES));
  });

  it('C9 — the same food row drives both accept surfaces identically', async () => {
    const order = await momoOrderFromApi();
    const popup = await mountModal(order);
    const card = await mountDecisionCard(order);

    expect(stepperValue(popup)).toBe(stepperValue(card.tree));
    expect(hostTexts(popup)).toContain('Making Time');
    expect(hostTexts(card.tree)).toContain('Making Time');

    await press(popup, 'prep-minus');
    await press(card.tree, 'prep-minus');
    expect(stepperValue(popup)).toBe(minutes(29));
    expect(stepperValue(card.tree)).toBe(minutes(29));
  });
});

/* ── The countdown lives only in Processing ─────────────────────────────
 *
 * Once the order leaves the kitchen the timer must stop and the row must
 * report how long the food actually took. Both numbers come from instants the
 * server stamped itself: the duration is `accepted_at` → `prepared_at` and the
 * lateness is `preparation_due_at` → `prepared_at`. The selected making time is
 * never either of them, and the device clock is never read, so a restart, a
 * second phone, or a stale tab cannot restate it.
 */

const ACCEPT_AT = '2026-09-30T14:00:00.000Z';

describe('the frozen preparation duration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** The user's example: accepted 2:00 PM, ready 2:24 PM → 24 min. */
  const READY_AT = '2026-09-30T14:24:00.000Z';
  /** Selected 30, took 37 → `Prepared in 37 min · Late by 7 min`. */
  const SLOW_READY_AT = '2026-09-30T14:37:00.000Z';
  /** The deadline for a 30 minute selection, so lateness is real. */
  const DUE_30 = '2026-09-30T14:30:00.000Z';

  const live = (texts: string[]) =>
    texts.filter(t => ['Ready in', 'Late by', 'Late'].includes(t));

  /**
   * The frozen row is two text nodes — the neutral duration and the red
   * lateness — so the sentence is read back by joining the two.
   */
  const sentence = (texts: string[]) =>
    texts
      .filter(t => t.startsWith('Prepared in') || t.startsWith('· Late by'))
      .join(' ');

  const sentenceOf = (order: Order) => {
    const label = preparationLabel(preparationSummary(order)!);
    return [label.prepared, label.late].filter(Boolean).join(' ');
  };

  /** A finished food order: `selected` making time, ready `afterMinutes` later. */
  function finished(
    selected: number,
    afterMinutes: number,
    overrides: Partial<Order> = {},
    afterSeconds = 0
  ): Order {
    const iso = (minutes: number, seconds = 0) =>
      new Date(Date.parse(ACCEPT_AT) + minutes * 60_000 + seconds * 1000).toISOString();
    return foodOrder({
      status: 'shipped',
      acceptedAt: iso(0),
      preparationTimeMinutes: selected,
      preparationDueAt: iso(selected),
      preparedAt: iso(afterMinutes, afterSeconds),
      ...overrides,
    });
  }

  it('P1 — a Processing order still counts down, exactly as before', async () => {
    const order = foodOrder({
      status: 'confirmed',
      acceptedAt: ACCEPT_AT,
      preparationTimeMinutes: 25,
      preparationDueAt: DUE,
    });
    expect(showsPreparationTimer(order)).toBe(true);

    const card = await mountCard(order, DUE_MS - 600_000);
    const texts = hostTexts(card);
    expect(texts).toContain('Ready in');
    expect(texts).toContain('10:00');
    expect(texts).not.toContain('Prepared in 24 min');
  });

  it('P2 — a Processing order past its deadline shows the red Late by timer', async () => {
    const order = foodOrder({
      status: 'packed',
      acceptedAt: ACCEPT_AT,
      preparationTimeMinutes: 25,
      preparationDueAt: DUE,
    });

    const card = await mountCard(order, DUE_MS + 120_000);
    const texts = hostTexts(card);
    expect(texts).toContain('Late by');
    expect(texts).toContain('+02:00');
    expect(texts).toContain('Late');
  });

  it('P3 — an order that left Processing stops counting and shows the actual time', async () => {
    const order = foodOrder({
      status: 'shipped',
      acceptedAt: ACCEPT_AT,
      preparedAt: READY_AT,
      preparationTimeMinutes: 30,
      preparationDueAt: DUE_30,
    });

    // The device clock is far past the deadline; a live countdown would say
    // `Late by`. It does not — the row is frozen and on time.
    const card = await mountCard(order, DUE_MS + 86_400_000);
    const texts = hostTexts(card);
    expect(live(texts)).toEqual([]);
    expect(texts).toContain('Prepared in 24 min');
    expect(preparationSummary(order)).toEqual({
      actualSeconds: 1440,
      lateSeconds: null,
    });
  });

  it('P4 — going past the deadline is reported from the deadline, not the selection', () => {
    const order = foodOrder({
      status: 'delivered',
      acceptedAt: ACCEPT_AT,
      preparedAt: SLOW_READY_AT,
      preparationTimeMinutes: 30,
      preparationDueAt: DUE_30,
    });

    expect(sentenceOf(order)).toBe('Prepared in 37 min · Late by 7 min');
    /* The lateness is its own node so it can be red while the duration is not. */
    expect(preparationLabel(preparationSummary(order)!)).toEqual({
      prepared: 'Prepared in 37 min',
      late: '· Late by 7 min',
    });
  });

  it('P4b — finishing early never claims lateness', () => {
    const order = foodOrder({
      status: 'delivered',
      acceptedAt: ACCEPT_AT,
      preparedAt: READY_AT,
      preparationTimeMinutes: 30,
      preparationDueAt: DUE_30,
    });

    expect(sentenceOf(order)).toBe('Prepared in 24 min');
    expect(preparationLabel(preparationSummary(order)!).late).toBeNull();
  });

  it('P5 — a Dispatch-tab card never keeps counting, whatever the clock says', async () => {
    const order = foodOrder({
      status: 'shipped',
      acceptedAt: ACCEPT_AT,
      preparedAt: SLOW_READY_AT,
      preparationTimeMinutes: 30,
      preparationDueAt: DUE_30,
    });

    const first = hostTexts(await mountCard(order, DUE_MS + 60_000));
    const second = hostTexts(await mountCard(order, DUE_MS + 9 * 3_600_000));

    expect(live(first)).toEqual([]);
    expect(live(second)).toEqual([]);
    expect(sentence(first)).toBe('Prepared in 37 min · Late by 7 min');
    expect(sentence(second)).toBe(sentence(first));
  });

  it('P6 — a restart re-reads the same frozen duration from the row', async () => {
    const row = rawOrder({
      status: 'shipped',
      accepted_at: ACCEPT_AT,
      prepared_at: SLOW_READY_AT,
      preparation_time_minutes: 30,
      preparation_due_at: DUE_30,
    });

    // Before the restart and after it: two separate fetches of the same row.
    mockApiGet.mockResolvedValueOnce([row]);
    const [before] = await getOrders();
    mockApiGet.mockResolvedValueOnce([row]);
    const [after] = await getOrders();

    expect(before.preparedAt).toBe(SLOW_READY_AT);
    expect(preparationSummary(after)).toEqual(preparationSummary(before));
    expect(sentenceOf(after)).toBe('Prepared in 37 min · Late by 7 min');
  });

  it('P7 — two devices reading the same row print the same sentence', async () => {
    const row = rawOrder({
      status: 'delivered',
      accepted_at: ACCEPT_AT,
      prepared_at: READY_AT,
      preparation_time_minutes: 30,
    });
    mockApiGet.mockResolvedValueOnce([row, row]);
    const [phoneA, phoneB] = await getOrders();

    const cardA = hostTexts(await mountCard(phoneA, DUE_MS));
    const cardB = hostTexts(await mountCard(phoneB, DUE_MS + 720_000));

    expect(sentence(cardA)).toBe('Prepared in 24 min');
    expect(sentence(cardB)).toBe(sentence(cardA));
  });

  it('P8 — an order finished before prepared_at existed invents no duration', async () => {
    const order = foodOrder({
      status: 'shipped',
      acceptedAt: ACCEPT_AT,
      preparationTimeMinutes: 25,
      preparationDueAt: DUE,
    });

    expect(preparationSummary(order)).toBeNull();
    const texts = hostTexts(await mountCard(order, DUE_MS + 600_000));
    expect(live(texts)).toEqual([]);
    expect(texts.some(t => t.startsWith('Prepared in'))).toBe(false);
  });

  it('P8b — a contradictory pair of instants is not shown as a duration', () => {
    expect(
      preparationSummary(
        foodOrder({
          status: 'shipped',
          acceptedAt: SLOW_READY_AT,
          preparedAt: ACCEPT_AT,
        }),
      ),
    ).toBeNull();
  });

  it('P9 — a non-food order is untouched outside Processing', async () => {
    const shipped: Order = { ...nonFoodOrder(), status: 'shipped' };

    expect(preparationSummary(shipped)).toBeNull();
    expect(showsPreparationTimer(shipped)).toBe(false);

    const texts = hostTexts(await mountCard(shipped, DUE_MS));
    expect(live(texts)).toEqual([]);
    expect(texts.some(t => t.startsWith('Prepared in'))).toBe(false);
  });

  it('P10 — the client never sends a timestamp of its own', async () => {
    await acceptOrder('order-1', 35);

    const body = mockApiPut.mock.calls[0][1] as Record<string, unknown>;
    // Race protection depends on this: only the winning accept claim on the
    // server may stamp accepted_at / preparation_due_at / prepared_at.
    expect(Object.keys(body).sort()).toEqual([
      'preparation_time_minutes',
      'status',
    ]);
  });

  it('P10b — losing the accept race leaves no local timer behind', async () => {
    mockApiPut.mockRejectedValueOnce({
      status: 409,
      error: 'ORDER_ALREADY_PROCESSED',
    });

    await expect(acceptOrder('order-1', 20)).rejects.toMatchObject({ status: 409 });
    // Nothing was stamped on this device, so a pending order stays a pending
    // order: no countdown, no frozen duration.
    const order = foodOrder();
    expect(showsPreparationTimer(order)).toBe(false);
    expect(preparationSummary(order)).toBeNull();
  });

  /* ── The reported field bug: a late 1 minute order read "Prepared in 1 min" ── */

  it('F1 — a 1 minute target finished after 5 minutes is late by 4', async () => {
    const order = finished(1, 5);
    const texts = hostTexts(await mountCard(order, Date.parse(SLOW_READY_AT)));

    expect(preparationSummary(order)).toEqual({ actualSeconds: 300, lateSeconds: 240 });
    expect(sentence(texts)).toBe('Prepared in 5 min · Late by 4 min');
  });

  /** The real production row behind the Phase 8 report: 80.56 s of preparation
   *  against a 1 minute deadline. Whole-minute rounding made that read either
   *  "Prepared in 1 min" with nothing late, or "2 min · Late by 1 min". */
  it('F2 — the reported row prints its seconds, not rounded minutes', async () => {
    const order = foodOrder({
      status: 'shipped',
      acceptedAt: '2026-09-30T10:09:16.551Z',
      preparationTimeMinutes: 1,
      preparationDueAt: '2026-09-30T10:10:16.551Z',
      preparedAt: '2026-09-30T10:10:37.111Z',
    });
    const texts = hostTexts(await mountCard(order, DUE_MS));

    expect(preparationSummary(order)).toEqual({ actualSeconds: 80, lateSeconds: 20 });
    expect(sentence(texts)).toBe('Prepared in 1 min 20 sec · Late by 20 sec');
    // Neither of the two answers whole-minute maths could give.
    expect(texts).not.toContain('Prepared in 1 min');
    expect(texts).not.toContain('· Late by 1 min');
  });

  it('F3 — the selected making time is never used as the duration', () => {
    // Asked for 30, done in 5: the row must say 5, and must not be late.
    expect(preparationSummary(finished(30, 5))).toEqual({
      actualSeconds: 300,
      lateSeconds: null,
    });
    // Asked for 1, done in 37: the selection cannot make it 1.
    expect(sentenceOf(finished(1, 37))).toBe('Prepared in 37 min · Late by 36 min');
  });

  it('F4 — only the deadline can make an order late', () => {
    // No stored deadline: a long preparation past the selection is still not
    // described as late, because nothing was ever due.
    expect(
      preparationSummary(finished(20, 30, { preparationDueAt: undefined }))
    ).toEqual({ actualSeconds: 1800, lateSeconds: null });
    // Exactly at the deadline is on time.
    expect(preparationSummary(finished(30, 30))).toEqual({
      actualSeconds: 1800,
      lateSeconds: null,
    });
  });

  it('F5 — a part-minute is printed as seconds, never rounded up to a minute', () => {
    const order = finished(1, 1, {}, 20); // 1 min 20 s of a 1 min target
    expect(order.preparedAt).toBe('2026-09-30T14:01:20.000Z');
    expect(preparationSummary(order)).toEqual({ actualSeconds: 80, lateSeconds: 20 });
    expect(sentenceOf(order)).toBe('Prepared in 1 min 20 sec · Late by 20 sec');
  });

  it('F6 — the server numbers survive the mapping and win over local maths', async () => {
    /* A row that carries the computed durations, alongside timestamps that
     * would derive something else. The card prints what the backend decided,
     * which is what makes every device agree. */
    mockApiGet.mockResolvedValueOnce([
      rawOrder({
        status: 'shipped',
        accepted_at: ACCEPT_AT,
        prepared_at: READY_AT,
        preparation_due_at: DUE_30,
        preparation: { actual_seconds: 380, late_seconds: 305 },
      }),
    ]);
    const [order] = await getOrders();

    expect(order.preparation).toEqual({ actualSeconds: 380, lateSeconds: 305 });
    expect(preparationSummary(order)).toEqual({ actualSeconds: 380, lateSeconds: 305 });
    const texts = hostTexts(await mountCard(order, Date.now()));
    expect(sentence(texts)).toBe('Prepared in 6 min 20 sec · Late by 5 min 5 sec');
  });

  it('F7 — moving from Dispatch to Completed cannot restate the duration', async () => {
    const order = finished(1, 5);
    const dispatch = hostTexts(
      await mountCard(order, Date.parse('2026-09-30T18:00:00.000Z'))
    );
    const completed = hostTexts(
      await mountCard(
        { ...order, status: 'delivered' },
        Date.parse('2026-10-01T09:00:00.000Z')
      )
    );

    expect(sentence(dispatch)).toBe('Prepared in 5 min · Late by 4 min');
    expect(sentence(completed)).toBe(sentence(dispatch));
  });

  it('F8 — a non-food order still shows no duration', () => {
    const done = { ...nonFoodOrder(), status: 'delivered' as Order['status'] };
    expect(preparationSummary(done)).toBeNull();
  });
});

/* ── Phase 9 ─────────────────────────────────────────────────────────────
 *
 * Two field reports about the same card:
 *   BUG 1 — a Making Time of 1 opened in Processing at `00:42`.
 *   BUG 2 — 5 seconds of lateness printed as `Late by 1 min`.
 *
 * BUG 1 was not the deadline being wrong (the server stores `accepted_at` plus
 * exactly 60 000 ms — measured on the live API). It was the device throwing
 * away the accept response, which already carried that deadline, and learning
 * the timer only from the next order-list fetch. By then the kitchen had
 * genuinely been working for those seconds. The countdown is correct to show
 * them; it must not have to wait for a fetch to find them out.
 *
 * BUG 2 was units: both numbers were rounded to whole minutes.
 */
describe('Phase 9 — the server deadline arrives with the accept', () => {
  const T = Date.parse(ACCEPT_AT);
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** The reply to a successful accept of a `minutes` minute food order. */
  function acceptReply(minutes: number, over: Record<string, unknown> = {}) {
    return rawOrder({
      status: 'confirmed',
      accepted_at: iso(T),
      preparation_time_minutes: minutes,
      preparation_due_at: iso(T + minutes * 60_000),
      ...over,
    });
  }

  /** The row the cache holds once that reply has been applied. */
  const patched = (
    patch: PreparationTimerPatch,
    status: Order['status'] = 'confirmed',
  ) => ({
    ...foodOrder({ status }),
    ...patch,
  });

  it('T1 — a 1 minute order is due exactly 60 000 ms after accepted_at', () => {
    const patch = serverPreparationTimer('order-1', acceptReply(1))!;
    expect(Date.parse(patch.preparationDueAt!) - Date.parse(patch.acceptedAt!)).toBe(60_000);
    expect(patch.preparationTimeMinutes).toBe(1);
  });

  it('T2 — at the server acceptance instant the whole minute is still ahead', () => {
    expect(formatPreparationCountdown(T + 60_000, T)).toEqual({
      label: '01:00',
      late: false,
    });
  });

  it('T3 — 18 s of real kitchen work leaves 42 s, and the deadline itself never moves', async () => {
    const row = patched(serverPreparationTimer('order-1', acceptReply(1))!);

    expect(formatPreparationCountdown(preparationDueMs(row)!, T + 18_000).label).toBe('00:42');

    /* The deadline is the server's, not something a render or a clock tick
     * re-arms: two renders at different instants read the same stored instant. */
    const stored = preparationDueMs(row);
    await mountCard(row, T + 18_000);
    await mountCard(row, T + 55_000);
    expect(preparationDueMs(row)).toBe(stored);
    expect(stored).toBe(T + 60_000);
  });

  it('T4 — the accept response starts the countdown, with no list fetch in between', async () => {
    mockApiPut.mockResolvedValueOnce(acceptReply(1));
    const patch = await acceptOrder('order-1', 1);

    expect(patch).toEqual({
      acceptedAt: iso(T),
      preparationDueAt: iso(T + 60_000),
      preparationTimeMinutes: 1,
    });

    const row = patched(patch!);
    expect(showsPreparationTimer(row)).toBe(true);
    const texts = hostTexts(await mountCard(row, T + 18_000));
    expect(texts).toContain('Ready in');
    expect(texts).toContain('00:42');
  });

  it('T5 — nothing is invented when the reply has no readable deadline', async () => {
    expect(serverPreparationTimer('order-1', acceptReply(1, { id: 'order-2' }))).toBeNull();
    expect(serverPreparationTimer('order-1', acceptReply(1, { preparation_due_at: null }))).toBeNull();
    expect(serverPreparationTimer('order-1', acceptReply(1, { preparation_due_at: 'soon' }))).toBeNull();
    expect(serverPreparationTimer('order-1', undefined)).toBeNull();

    // A non-food accept: the server stores no timer, so this device shows none.
    mockApiPut.mockResolvedValueOnce(
      acceptReply(1, { preparation_due_at: null, accepted_at: null, preparation_time_minutes: null })
    );
    const patch = await acceptOrder('order-1', 1);
    expect(patch).toBeNull();
    expect(showsPreparationTimer(patched(patch ?? {}))).toBe(false);
  });

  it('T6 — an old cached row cannot delay the countdown a new device sees', () => {
    /* Before the fix the timer came from whatever the last list fetch returned,
     * so a row still marked pending offered no deadline at all. The accept
     * reply alone is enough now. */
    const stale = foodOrder({ status: 'pending' });
    expect(showsPreparationTimer(stale)).toBe(false);

    const fresh = patched(serverPreparationTimer('order-1', acceptReply(1))!);
    expect(fresh.status).toBe('confirmed');
    expect(showsPreparationTimer(fresh)).toBe(true);
  });
});

describe('Phase 9 — lateness and duration keep their seconds', () => {
  const T = Date.parse(ACCEPT_AT);
  const iso = (ms: number) => new Date(ms).toISOString();

  /** A 1 minute food order the kitchen finished `lateBy` seconds past the deadline. */
  function ready(lateBy: number, status: Order['status'] = 'shipped'): Order {
    return foodOrder({
      status,
      acceptedAt: iso(T),
      preparationTimeMinutes: 1,
      preparationDueAt: iso(T + 60_000),
      preparedAt: iso(T + 60_000 + lateBy * 1000),
    });
  }

  const sentenceOf = (order: Order) => {
    const label = preparationLabel(preparationSummary(order)!);
    return [label.prepared, label.late].filter(Boolean).join(' ');
  };

  /** The colour the card actually renders `text` with. */
  const colorOf = (tree: ReturnType<typeof create>, text: string) => {
    const [node] = tree.root.findAll(
      n => typeof n.type === 'string' && n.children.flat().map(String).join('') === text,
    );
    return (StyleSheet.flatten(node?.props.style) as { color?: string } | undefined)?.color;
  };

  it('T7 — exact seconds are printed as seconds, never rounded up to a minute', () => {
    expect(formatPreparationDuration(5)).toBe('5 sec');
    expect(formatPreparationDuration(45)).toBe('45 sec');
    expect(formatPreparationDuration(59)).toBe('59 sec');
    expect(formatPreparationDuration(60)).toBe('1 min');
    expect(formatPreparationDuration(65)).toBe('1 min 5 sec');
    expect(formatPreparationDuration(125)).toBe('2 min 5 sec');
  });

  it('T8 — the late caption reads 5 sec, 59 sec, 1 min, 1 min 5 sec, 2 min 5 sec', () => {
    expect(sentenceOf(ready(5))).toBe('Prepared in 1 min 5 sec · Late by 5 sec');
    expect(sentenceOf(ready(59))).toBe('Prepared in 1 min 59 sec · Late by 59 sec');
    expect(sentenceOf(ready(60))).toBe('Prepared in 2 min · Late by 1 min');
    expect(sentenceOf(ready(65))).toBe('Prepared in 2 min 5 sec · Late by 1 min 5 sec');
    expect(sentenceOf(ready(125))).toBe('Prepared in 3 min 5 sec · Late by 2 min 5 sec');
  });

  it('T9 — a 45 second kitchen is reported in seconds and is not late', () => {
    const early = foodOrder({
      status: 'shipped',
      acceptedAt: iso(T),
      preparationTimeMinutes: 1,
      preparationDueAt: iso(T + 60_000),
      preparedAt: iso(T + 45_000),
    });

    expect(preparationSummary(early)).toEqual({ actualSeconds: 45, lateSeconds: null });
    expect(sentenceOf(early)).toBe('Prepared in 45 sec');
  });

  it('T10 — Dispatch shows the same frozen seconds the kitchen ended with', async () => {
    const order = ready(5);
    const card = await mountCard(order, T + 9 * 3_600_000);
    const texts = hostTexts(card);

    expect(texts.filter(t => ['Ready in', 'Late by', 'Late'].includes(t))).toEqual([]);
    expect(texts).toContain('Prepared in 1 min 5 sec');
    expect(texts).toContain('· Late by 5 sec');

    /* The lateness is the thing the vendor must notice, so it is the red part;
     * the duration itself stays neutral. And it cannot grow: the same row hours
     * later says the same. */
    expect(colorOf(card, '· Late by 5 sec')).toBe(Colors.danger);
    expect(colorOf(card, 'Prepared in 1 min 5 sec')).not.toBe(Colors.danger);
    expect(hostTexts(await mountCard(order, T + 48 * 3_600_000))).toEqual(texts);
  });

  it('T11 — a restart and a second phone print the same seconds', async () => {
    const row = rawOrder({
      status: 'shipped',
      accepted_at: iso(T),
      preparation_due_at: iso(T + 60_000),
      prepared_at: iso(T + 65_000),
      preparation_time_minutes: 1,
    });

    mockApiGet.mockResolvedValueOnce([row]);
    const [phoneA] = await getOrders();
    mockApiGet.mockResolvedValueOnce([row]);
    const [phoneB] = await getOrders();

    expect(preparationSummary(phoneA)).toEqual({ actualSeconds: 65, lateSeconds: 5 });
    expect(hostTexts(await mountCard(phoneA, T + 65_000))).toEqual(
      hostTexts(await mountCard(phoneB, T + 4_000_000)),
    );
  });

  it('T12 — the seconds the server computed win, and the selector never becomes a duration', () => {
    // A 1 minute selection that took 4 minutes: 240 s, late by 180 s.
    const order = ready(180);
    expect(order.preparationTimeMinutes).toBe(1);
    expect(preparationSummary(order)).toEqual({ actualSeconds: 240, lateSeconds: 180 });
    expect(sentenceOf(order)).toBe('Prepared in 4 min · Late by 3 min');
  });
});

/* ── Phase 10 — the redesigned popup ────────────────────────────────────
 *
 * The redesign moved content around: every item is listed instead of five plus
 * a "+N more" note, payment reads as its own badges, and Making Time with both
 * decisions sits in a footer outside the scroll. None of that may change what a
 * decision sends, so these tests pin the render contract the taps depend on.
 */

/** Walk up from a host label to the control that owns its `onPress`. */
function stepLabeled(tree: ReturnType<typeof create>, label: string) {
  const node = tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.children.flat().map(String).join('') === label,
  )[0];
  if (!node) return undefined;
  let current: typeof node.parent = node.parent;
  while (current && typeof current.props?.onPress !== 'function') {
    current = current.parent;
  }
  return current;
}

async function mountPopup(order: Order, onAccept: jest.Mock, onReject: jest.Mock) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = track(
      create(
        <NewOrderAlertModal
          visible
          order={order}
          onAccept={onAccept}
          onReject={onReject}
        />,
      ),
    );
  });
  await act(async () => {});
  return tree;
}

describe('the redesigned alert popup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('U1 — a many-product order lists every item, and the controls stay after it', async () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      id: `i${index}`,
      name: `Item ${index + 1}`,
      quantity: index + 1,
      price: 100,
      total: 100 * (index + 1),
      ready: false,
      cancelled: false,
      itemType: 'food',
    }));
    const tree = await mountModal(foodOrder({ items }));
    const texts = hostTexts(tree);

    expect(texts).toContain('Items (7)');
    for (let index = 1; index <= 7; index += 1) {
      expect(texts).toContain(`Item ${index}`);
    }
    // Nothing is folded away behind a note any more — the body scrolls instead.
    expect(texts.some(t => t.includes('more item'))).toBe(false);
    // The footer still comes after the list, so Making Time is above the tap.
    expect(texts.indexOf('Item 7')).toBeLessThan(texts.indexOf('Making Time'));
    expect(texts.indexOf('Making Time')).toBeLessThan(texts.indexOf('Accept'));
  });

  it('U2 — payment reads as its own values, and no payment paints no badge', async () => {
    const paid = hostTexts(
      await mountModal(foodOrder({ paymentMethod: 'UPI', paymentStatus: 'Paid' })),
    );
    expect(paid).toContain('UPI');
    expect(paid).toContain('Paid');
    expect(paid).not.toContain('UPI · Paid');

    const bare = hostTexts(
      await mountModal(foodOrder({ paymentMethod: undefined, paymentStatus: undefined })),
    );
    expect(bare).not.toContain('UPI');
    expect(bare).toContain('₹250');
    expect(bare).toContain('Making Time');
    expect(bare).toContain('Accept');
  });

  it('U3 — the header names the order and the body keeps the received time', async () => {
    const texts = hostTexts(await mountModal(foodOrder({ orderNumber: '1042' })));

    expect(texts).toContain('NEW ORDER');
    expect(texts).toContain('Order #1042');
    expect(texts).toContain('Test Customer');
    expect(texts).toContain('📞 9999999999');
    expect(texts.some(t => t.startsWith('Received at'))).toBe(true);
  });

  it('U4 — Reject still silences the alert and passes only the order id', async () => {
    const onReject = jest.fn();
    const tree = await mountPopup(foodOrder(), jest.fn(), onReject);

    await act(async () => {
      stepLabeled(tree, 'Reject')!.props.onPress();
    });

    expect(onReject).toHaveBeenCalledWith('order-1');
    expect(mockStopOrderAlertSound).toHaveBeenCalled();
    // A redesign of the popup must not decide anything by itself.
    expect(mockApiPut).not.toHaveBeenCalled();
  });

  it('U5 — Accept after stepping sends the selection, from the footer', async () => {
    const onAccept = jest.fn();
    const tree = await mountPopup(foodOrder(), onAccept, jest.fn());

    await press(tree, 'prep-minus', 4);
    expect(stepperValue(tree)).toBe(minutes(26));
    await act(async () => {
      stepLabeled(tree, 'Accept')!.props.onPress();
    });

    expect(onAccept).toHaveBeenCalledWith('order-1', 26);
    expect(mockApiPut).not.toHaveBeenCalled();
  });
});
