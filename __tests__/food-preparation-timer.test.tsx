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
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

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
  isFoodItem,
  isFoodOrder,
  preparationDueMs,
  showsPreparationTimer,
} from '../src/services/prepTimer';
import type { Order, OrderItem } from '../src/types';

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

  it.each(['confirmed', 'processing', 'packed', 'shipped'] as const)(
    '%s is still owed kitchen time',
    status => {
      expect(showsPreparationTimer(foodOrder({ status: status as Order['status'], ...accepted }))).toBe(
        true,
      );
    },
  );

  it.each(['delivered', 'cancelled', 'refunded'] as const)(
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
