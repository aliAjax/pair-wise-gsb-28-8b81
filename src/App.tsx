import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

/* ---------------- 领域模型与常量 ---------------- */

type OrderStatus = "pending" | "scheduled" | "delivering" | "completed";

interface Order {
  id: string;
  orderNo: string;
  destination: string;
  weight: number; // kg
  startAt: string; // datetime-local，配送开始时间
  endAt: string; // datetime-local，配送结束时间
  status: OrderStatus;
  driverId: string | null;
  note: string;
  createdAt: string;
}

interface Driver {
  id: string;
  name: string;
  plate: string;
}

const STORAGE_KEY = "hxwlfront-14-schedule-v2";
const DRIVERS: Driver[] = [
  { id: "liu", name: "刘师傅", plate: "沪A·1023" },
  { id: "zhao", name: "赵师傅", plate: "沪B·4471" },
  { id: "sun", name: "孙师傅", plate: "沪C·7820" },
];
const POOL_ID = "pool";
const MAX_DAILY_WEIGHT = 500; // kg
const MIN_GAP_MINUTES = 30;

const STATUS_META: Record<OrderStatus, { label: string; className: string }> = {
  pending: { label: "待分配", className: "pending" },
  scheduled: { label: "已排班", className: "scheduled" },
  delivering: { label: "配送中", className: "delivering" },
  completed: { label: "已完成", className: "completed" },
};

const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  scheduled: "delivering",
  delivering: "completed",
};

/* ---------------- 时间工具 ---------------- */

function dayKey(value: string): string {
  return value ? value.slice(0, 10) : "";
}

function minutesOf(value: string): number {
  const [, hhmm = ""] = value.split("T");
  const [hh, mm] = hhmm.split(":").map(Number);
  return (hh || 0) * 60 + (mm || 0);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayAt(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return localDateTime(d);
}

function formatRange(order: Order): string {
  const s = `${dayKey(order.startAt).slice(5)} ${order.startAt.slice(11, 16)}`;
  const e = `${dayKey(order.endAt).slice(5)} ${order.endAt.slice(11, 16)}`;
  return `${s} → ${e}`;
}

const todayKey = dayKey(localDateTime(new Date()));

/* ---------------- 派单校验 ---------------- */

interface AssignIssue {
  key: string;
  orderId: string;
  target: string; // droppable id：POOL_ID 或 driver:xxx
  weightConflictOrderIds?: string[];
  overloadKg?: number;
  projectedWeight?: number;
  dayLabel?: string;
  message?: string;
}

/** 计算把 order 派给 targetDriverId 时产生的冲突；无冲突返回 null */
function evaluateAssign(
  order: Order,
  targetDriverId: string,
  orders: Order[],
  drivers: Driver[]
): Omit<AssignIssue, "key" | "orderId" | "target"> | null {
  const targetDriver = drivers.find((d) => d.id === targetDriverId);
  if (!targetDriver) return { message: "目标司机不存在" };

  // 已开始配送的订单不能改派
  if (order.status === "delivering" || order.status === "completed") {
    return { message: `${STATUS_META[order.status].label}的订单不能改派` };
  }

  const orderDay = dayKey(order.startAt);
  // 同一司机同一天的既有订单（改派时排除自身，即“先释放原司机负荷”）
  const sameDay = orders.filter(
    (o) =>
      o.id !== order.id &&
      o.driverId === targetDriverId &&
      o.status !== "pending" &&
      dayKey(o.startAt) === orderDay
  );

  // 单日累计重量
  const existedWeight = sameDay.reduce((sum, o) => sum + o.weight, 0);
  const dayTotal = existedWeight + order.weight;
  const overload = dayTotal > MAX_DAILY_WEIGHT ? dayTotal - MAX_DAILY_WEIGHT : 0;

  // 时间间隔：同一司机当天相邻两单至少间隔 30 分钟
  const sorted = [...sameDay, order].sort((a, b) => minutesOf(a.startAt) - minutesOf(b.startAt));
  const conflictOrderIds: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const gap = minutesOf(sorted[j].startAt) - minutesOf(sorted[i].endAt);
      if (gap < MIN_GAP_MINUTES) {
        const other = sorted[i].id === order.id ? sorted[j] : sorted[j].id === order.id ? sorted[i] : null;
        if (other) conflictOrderIds.push(other.id);
      }
    }
  }

  if (overload <= 0 && conflictOrderIds.length === 0) return null;
  return {
    weightConflictOrderIds: conflictOrderIds.length ? [...new Set(conflictOrderIds)] : undefined,
    overloadKg: overload > 0 ? overload : undefined,
    projectedWeight: overload > 0 ? dayTotal : undefined,
    dayLabel: orderDay,
  };
}

/* ---------------- 种子数据与持久化 ---------------- */

function seedOrders(): Order[] {
  return [
    {
      id: "seed-1",
      orderNo: "ORD-3001",
      destination: "浦东仓库",
      weight: 260,
      startAt: todayAt(9, 0),
      endAt: todayAt(10, 0),
      status: "scheduled",
      driverId: "liu",
      note: "上午第一单",
      createdAt: new Date().toISOString(),
    },
    {
      id: "seed-2",
      orderNo: "ORD-3002",
      destination: "虹桥站点",
      weight: 200,
      startAt: todayAt(10, 20),
      endAt: todayAt(11, 10),
      status: "delivering",
      driverId: "zhao",
      note: "已出发，不可改派",
      createdAt: new Date().toISOString(),
    },
    {
      id: "seed-3",
      orderNo: "ORD-3003",
      destination: "嘉定工业园",
      weight: 280,
      startAt: todayAt(14, 0),
      endAt: todayAt(15, 0),
      status: "pending",
      driverId: null,
      note: "拖给司机即完成排班",
      createdAt: new Date().toISOString(),
    },
    {
      id: "seed-4",
      orderNo: "ORD-3004",
      destination: "松江新城",
      weight: 60,
      startAt: todayAt(10, 15),
      endAt: todayAt(10, 55),
      status: "pending",
      driverId: null,
      note: "可用于测试 30 分钟间隔",
      createdAt: new Date().toISOString(),
    },
  ];
}

function loadOrders(): Order[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Order[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 数据损坏时回退到种子数据 */
    }
  }
  return seedOrders();
}

/* ---------------- 可拖拽订单卡片 ---------------- */

function OrderCardBody({ order, dimmed }: { order: Order; dimmed?: boolean }) {
  const locked = order.status === "delivering" || order.status === "completed";
  return (
    <article className={`order-card ${locked ? "locked" : ""} ${dimmed ? "dimmed" : ""}`}>
      <div className="order-card-head">
        <strong>{order.orderNo}</strong>
        <span className={`badge ${STATUS_META[order.status].className}`}>{STATUS_META[order.status].label}</span>
      </div>
      <div className="order-card-body">
        <span>📍 {order.destination}</span>
        <span>🕒 {formatRange(order)}</span>
        <span className="weight">⚖ {order.weight} kg</span>
      </div>
      {order.note ? <p className="order-note">{order.note}</p> : null}
      {locked ? <p className="lock-hint">🔒 已开始配送，不可改派</p> : null}
    </article>
  );
}

function DraggableOrder({ order }: { order: Order }) {
  const locked = order.status === "delivering" || order.status === "completed";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: order.id,
    disabled: locked,
  });
  return (
    <div
      ref={setNodeRef}
      className={isDragging ? "dragging" : ""}
      {...(locked ? {} : listeners)}
      {...attributes}
      title={locked ? "已开始配送，不能改派" : "拖动派给司机"}
    >
      <OrderCardBody order={order} dimmed={isDragging} />
    </div>
  );
}

/* ---------------- 投放区 ---------------- */

interface DropZoneProps {
  id: string;
  className?: string;
  children: React.ReactNode;
}

function DropZone({ id, className, children }: DropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className ?? ""} ${isOver ? "over" : ""}`}>
      {children}
    </div>
  );
}

/* ---------------- 主应用 ---------------- */

interface NewOrderForm {
  orderNo: string;
  destination: string;
  weight: string;
  startAt: string;
  endAt: string;
  note: string;
}

function blankForm(): NewOrderForm {
  return { orderNo: "", destination: "", weight: "", startAt: "", endAt: "", note: "" };
}

export default function App() {
  const [orders, setOrders] = useState<Order[]>(loadOrders);
  const [form, setForm] = useState<NewOrderForm>(blankForm);
  const [formError, setFormError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, AssignIssue>>({});
  const [toast, setToast] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  }, [orders]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const pendingOrders = useMemo(
    () => orders.filter((o) => o.status === "pending"),
    [orders]
  );

  const metrics = useMemo(() => {
    const todayOrders = orders.filter((o) => o.status !== "pending" && dayKey(o.startAt) === todayKey);
    const todayWeight = todayOrders.reduce((sum, o) => sum + o.weight, 0);
    return {
      pending: orders.filter((o) => o.status === "pending").length,
      scheduled: orders.filter((o) => o.status === "scheduled").length,
      delivering: orders.filter((o) => o.status === "delivering").length,
      todayWeight,
    };
  }, [orders]);

  const activeOrder = activeId ? orders.find((o) => o.id === activeId) ?? null : null;

  function pushIssue(issue: AssignIssue) {
    setIssues((prev) => ({ ...prev, [issue.key]: issue }));
    window.setTimeout(() => {
      setIssues((prev) => {
        if (!prev[issue.key]) return prev;
        const next = { ...prev };
        delete next[issue.key];
        return next;
      });
    }, 12000);
  }

  function commit(next: Order[], okText?: string) {
    setOrders(next);
    if (okText) setToast(okText);
  }

  /* 新增待分配订单：必须填写配送开始、结束时间和重量 */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const weight = Number(form.weight);
    if (!form.orderNo.trim() || !form.destination.trim()) {
      setFormError("请填写订单号和目的地");
      return;
    }
    if (!form.weight || !(weight > 0)) {
      setFormError("请填写有效的重量（kg）");
      return;
    }
    if (!form.startAt || !form.endAt) {
      setFormError("请填写配送开始时间和结束时间");
      return;
    }
    if (form.endAt <= form.startAt) {
      setFormError("结束时间必须晚于开始时间");
      return;
    }
    const next: Order = {
      id: crypto.randomUUID(),
      orderNo: form.orderNo.trim(),
      destination: form.destination.trim(),
      weight: Math.round(weight * 10) / 10,
      startAt: form.startAt,
      endAt: form.endAt,
      status: "pending",
      driverId: null,
      note: form.note.trim(),
      createdAt: new Date().toISOString(),
    };
    commit([next, ...orders], `订单 ${next.orderNo} 已加入待分配`);
    setForm(blankForm());
    setFormError("");
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  /* 派单 / 改派：校验间隔与重量，超限则拒绝并在司机卡片下列出冲突 */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const orderId = String(active.id);
    const targetId = String(over.id);
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;

    // 拖回待分配池
    if (targetId === POOL_ID) {
      if (order.status === "pending" && order.driverId === null) return;
      if (order.status === "delivering" || order.status === "completed") {
        pushIssue({
          key: crypto.randomUUID(),
          orderId,
          target: POOL_ID,
          message: `${order.orderNo} 已开始配送，不能撤回待分配`,
        });
        return;
      }
      commit(
        orders.map((o) => (o.id === orderId ? { ...o, status: "pending" as const, driverId: null } : o)),
        `${order.orderNo} 已撤回待分配，原司机负荷已释放`
      );
      return;
    }

    if (!targetId.startsWith("driver:")) return;
    const driverId = targetId.slice("driver:".length);

    // 原排班未变化的情况直接忽略
    if (order.driverId === driverId && order.status !== "pending") return;

    const conflict = evaluateAssign(order, driverId, orders, DRIVERS);
    if (conflict) {
      // 关键：不修改 orders，原排班保持不变
      pushIssue({
        key: crypto.randomUUID(),
        orderId,
        target: targetId,
        ...conflict,
      });
      return;
    }

    commit(
      orders.map((o) => (o.id === orderId ? { ...o, status: "scheduled" as const, driverId } : o)),
      `${order.orderNo} ${order.driverId ? "改派" : "派单"}成功，原司机负荷已同步调整`
    );
  }

  /* 状态流转：开始配送 / 完成配送 */
  function advance(orderId: string) {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== orderId) return o;
        const next = NEXT_STATUS[o.status];
        return next ? { ...o, status: next } : o;
      })
    );
  }

  function removeOrder(orderId: string) {
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
  }

  const driverColumns = DRIVERS.map((driver) => {
    const assigned = orders
      .filter((o) => o.driverId === driver.id && o.status !== "pending")
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const groups = new Map<
      string,
      { orders: Order[]; weight: number }
    >();
    for (const o of assigned) {
      const key = dayKey(o.startAt);
      const group = groups.get(key) ?? { orders: [], weight: 0 };
      group.orders.push(o);
      group.weight += o.weight;
      groups.set(key, group);
    }
    const days = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { driver, assigned, days };
  });

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">物流配送调度</p>
            <h1>配送任务拖拽排班</h1>
            <p className="subtitle">
              待分配订单需填写配送时间与重量；拖给司机即派单，同一司机相邻两单至少间隔 {MIN_GAP_MINUTES} 分钟，
              单日累计重量不超过 {MAX_DAILY_WEIGHT}kg。超限时派单被拒绝，原排班保持不变。
            </p>
          </div>
          <div className="rules">
            <span>⏱ 相邻订单间隔 ≥ {MIN_GAP_MINUTES} 分钟</span>
            <span>⚖ 单人单日 ≤ {MAX_DAILY_WEIGHT}kg</span>
            <span>🔒 配送中 / 已完成不可改派</span>
          </div>
        </header>

        <section className="metrics">
          <article className="metric">
            <span>待分配订单</span>
            <strong>{metrics.pending}</strong>
          </article>
          <article className="metric">
            <span>已排班（今日口径）</span>
            <strong>{metrics.scheduled + metrics.delivering}</strong>
          </article>
          <article className="metric">
            <span>配送中</span>
            <strong>{metrics.delivering}</strong>
          </article>
          <article className="metric">
            <span>今日在途总重量</span>
            <strong>{metrics.todayWeight} kg</strong>
          </article>
        </section>

        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveId(null)}>
          <section className="board">
            {/* 待分配池 */}
            <DropZone id={POOL_ID} className="pool-zone">
              <div className="pool-head">
                <h2>待分配订单（{pendingOrders.length}）</h2>
                <span className="hint">拖到下方司机卡片完成派单</span>
              </div>
              <div className="pool-list">
                {pendingOrders.length === 0 ? (
                  <div className="empty">暂无待分配订单，请在左侧新增</div>
                ) : (
                  pendingOrders.map((order) => <DraggableOrder key={order.id} order={order} />)
                )}
              </div>
              {Object.values(issues)
                .filter((issue) => issue.target === POOL_ID)
                .map((issue) => (
                  <div className="issue-panel" key={issue.key}>
                    <button type="button" className="issue-close" onClick={() => setIssues((p) => { const n = { ...p }; delete n[issue.key]; return n; })}>×</button>
                    <p className="issue-title">⛔ 无法撤回待分配</p>
                    <p className="issue-msg">{issue.message}</p>
                  </div>
                ))}
            </DropZone>

            {/* 司机卡片 */}
            <div className="drivers-grid">
              {driverColumns.map(({ driver, days }) => {
                const todayGroup = days.find(([key]) => key === todayKey);
                const todayWeight = todayGroup?.[1].weight ?? 0;
                const percent = Math.min(100, (todayWeight / MAX_DAILY_WEIGHT) * 100);
                const over = todayWeight > MAX_DAILY_WEIGHT;
                const driverIssues = Object.values(issues).filter((i) => i.target === `driver:${driver.id}`);

                return (
                  <DropZone id={`driver:${driver.id}`} className="driver-zone" key={driver.id}>
                    <div className="driver-card">
                      <div className="driver-head">
                        <div>
                          <h3>{driver.name}</h3>
                          <p>{driver.plate}</p>
                        </div>
                        <span className="driver-count">{days.reduce((n, [, g]) => n + g.orders.length, 0)} 单</span>
                      </div>

                      <div className={`load ${over ? "over" : ""}`}>
                        <div className="load-row">
                          <span>今日负荷</span>
                          <strong>
                            {todayWeight}/{MAX_DAILY_WEIGHT}kg
                          </strong>
                        </div>
                        <div className="load-track">
                          <div className="load-fill" style={{ width: `${percent}%` }} />
                        </div>
                      </div>

                      <div className="driver-orders">
                        {days.length === 0 ? <div className="empty small">暂无排班，拖入待分配订单</div> : null}
                        {days.map(([key, group]) => (
                          <div className="day-group" key={key}>
                            <div className="day-head">
                              <span>{key === todayKey ? `今天 ${key}` : key}</span>
                              <em className={group.weight > MAX_DAILY_WEIGHT ? "danger-text" : ""}>
                                {group.orders.length} 单 · {group.weight}kg
                              </em>
                            </div>
                            {group.orders.map((order) => (
                              <div key={order.id} className="driver-order-wrap">
                                <DraggableOrder order={order} />
                                {order.status === "scheduled" ? (
                                  <div className="inline-actions">
                                    <button type="button" className="mini" onClick={() => advance(order.id)}>
                                      开始配送
                                    </button>
                                    <button type="button" className="mini danger" onClick={() => removeOrder(order.id)}>
                                      删除
                                    </button>
                                  </div>
                                ) : null}
                                {order.status === "delivering" ? (
                                  <div className="inline-actions">
                                    <button type="button" className="mini" onClick={() => advance(order.id)}>
                                      完成配送
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>

                      {/* 冲突提示：列出冲突订单与超出重量，原排班未变化 */}
                      {driverIssues.map((issue) => {
                        const dropped = orders.find((o) => o.id === issue.orderId);
                        const conflictOrders = (issue.weightConflictOrderIds ?? [])
                          .map((id) => orders.find((o) => o.id === id))
                          .filter((o): o is Order => Boolean(o));
                        return (
                          <div className="issue-panel" key={issue.key}>
                            <button
                              type="button"
                              className="issue-close"
                              onClick={() =>
                                setIssues((p) => {
                                  const n = { ...p };
                                  delete n[issue.key];
                                  return n;
                                })
                              }
                            >
                              ×
                            </button>
                            <p className="issue-title">
                              ⛔ 无法派给 {driver.name}
                              {dropped ? `：${dropped.orderNo}` : ""}
                            </p>
                            {issue.message ? <p className="issue-msg">{issue.message}</p> : null}
                            {conflictOrders.length > 0 ? (
                              <div className="issue-block">
                                <p>与以下订单间隔不足 {MIN_GAP_MINUTES} 分钟：</p>
                                <ul>
                                  {conflictOrders.map((o) => (
                                    <li key={o.id}>
                                      {o.orderNo}（{o.startAt.slice(11, 16)}–{o.endAt.slice(11, 16)}，{o.weight}kg）
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                            {issue.overloadKg ? (
                              <p className="issue-msg danger-text">
                                {issue.dayLabel} 累计将达 {issue.projectedWeight}kg，超出限额 {Math.round(issue.overloadKg * 10) / 10}kg
                              </p>
                            ) : null}
                            <p className="issue-foot">原排班保持不变，请调整时间或改派其他司机</p>
                          </div>
                        );
                      })}
                    </div>
                  </DropZone>
                );
              })}
            </div>
          </section>

          <DragOverlay>
            {activeOrder ? (
              <div className="overlay-card">
                <OrderCardBody order={activeOrder} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* 新增订单表单 */}
        <section className="form-section">
          <form className="panel" onSubmit={handleSubmit}>
            <h2>新增待分配订单</h2>
            <div className="form-grid">
              <label>
                订单号
                <input
                  value={form.orderNo}
                  onChange={(e) => setForm({ ...form, orderNo: e.target.value })}
                  placeholder="例如 ORD-3010"
                  required
                />
              </label>
              <label>
                目的地
                <input
                  value={form.destination}
                  onChange={(e) => setForm({ ...form, destination: e.target.value })}
                  placeholder="例如 浦东仓库"
                  required
                />
              </label>
              <label>
                重量（kg）
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={form.weight}
                  onChange={(e) => setForm({ ...form, weight: e.target.value })}
                  required
                />
              </label>
              <label>
                配送开始时间
                <input
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(e) => setForm({ ...form, startAt: e.target.value })}
                  required
                />
              </label>
              <label>
                配送结束时间
                <input
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) => setForm({ ...form, endAt: e.target.value })}
                  required
                />
              </label>
              <label className="full">
                备注
                <input
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  placeholder="选填"
                />
              </label>
            </div>
            {formError ? <p className="form-error">{formError}</p> : null}
            <button type="submit" className="submit-btn">加入待分配</button>
          </form>
        </section>
      </div>

      {toast ? (
        <div className="toast">{toast}</div>
      ) : null}
    </main>
  );
}
