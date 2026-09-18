import { FormEvent, useMemo, useState } from "react";
import { DndContext, DragEndEvent, rectIntersection, useDraggable, useDroppable } from "@dnd-kit/core";

type Order = {
  id: string;
  orderNo: string;
  destination: string;
  weight: number;
  startTime: string; // datetime-local: YYYY-MM-DDTHH:mm
  endTime: string;
  driver: string; // "" 表示待分配
  status: string;
  notes: string;
  createdAt: string;
};

type ConflictInfo = {
  attemptOrderNo: string;
  timeConflicts: string[]; // 形如 "ORD-A ↔ ORD-B"
  overweight: number; // 超出的 kg，0 表示未超重
  day: string;
  totalWeight: number;
};

const DRIVERS = ["刘师傅", "赵师傅", "孙师傅"];
const STATUSES = ["待分配", "已分配", "配送中", "已完成"];
const GAP_MINUTES = 30; // 同一司机相邻两单最小间隔
const MAX_DAILY_WEIGHT = 500; // 单司机单日累计重量上限 kg
const STORAGE_KEY = "hxwlfront-14-schedule";

const STATUS_CLASS: Record<string, string> = {
  待分配: "st-pending",
  已分配: "st-assigned",
  配送中: "st-delivering",
  已完成: "st-done"
};

function todayAt(time: string) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${time}`;
}

function seedRecords(): Order[] {
  const seeds: Array<Partial<Order> & Pick<Order, "orderNo" | "destination" | "weight" | "startTime" | "endTime" | "status">> = [
    { orderNo: "ORD-9012", destination: "浦东", weight: 260, startTime: todayAt("08:00"), endTime: todayAt("10:00"), status: "已分配", driver: "刘师傅", notes: "上午配送" },
    { orderNo: "ORD-9014", destination: "徐汇", weight: 180, startTime: todayAt("11:00"), endTime: todayAt("12:30"), status: "已分配", driver: "刘师傅", notes: "中午前送达" },
    { orderNo: "ORD-9031", destination: "嘉定", weight: 140, startTime: todayAt("09:00"), endTime: todayAt("11:00"), status: "待分配", driver: "", notes: "待排班" },
    { orderNo: "ORD-9032", destination: "松江", weight: 60, startTime: todayAt("13:00"), endTime: todayAt("15:00"), status: "待分配", driver: "", notes: "待排班" },
    { orderNo: "ORD-9033", destination: "青浦", weight: 100, startTime: todayAt("14:00"), endTime: todayAt("16:00"), status: "待分配", driver: "", notes: "待排班" }
  ];
  return seeds.map((seed, index) => ({
    notes: "暂无备注",
    driver: "",
    ...seed,
    id: `seed-${index + 1}`,
    createdAt: new Date(Date.now() - index * 86400000).toISOString()
  })) as Order[];
}

function isOrderShape(item: unknown): item is Order {
  const o = item as Order;
  return !!o && typeof o.orderNo === "string" && typeof o.startTime === "string" && typeof o.endTime === "string" && typeof o.weight === "number";
}

function loadRecords(): Order[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown[];
      if (Array.isArray(parsed) && parsed.every(isOrderShape)) return parsed;
    } catch {
      // 数据损坏时回退到种子数据
    }
  }
  return seedRecords();
}

function saveRecords(records: Order[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function dayKey(order: Pick<Order, "startTime">) {
  return order.startTime.slice(0, 10);
}

function fmtTime(value: string) {
  return value.replace("T", " ");
}

// 占用司机排班/负荷的状态：已分配 + 配送中
function occupiesDriver(order: Order) {
  return order.status === "已分配" || order.status === "配送中";
}

/**
 * 校验把 candidate 加入司机现有排班后是否合法：
 * 1. 按开始时间排序后，相邻两单间隔必须 >= 30 分钟（含重叠检测）；
 * 2. 单日累计重量不得超过 500kg。
 * 返回 null 表示可以派单，否则返回冲突详情。
 */
function checkAssignment(driverOrders: Order[], candidate: Order): ConflictInfo | null {
  const all = [...driverOrders, candidate].sort((a, b) => a.startTime.localeCompare(b.startTime));

  const timeConflicts: string[] = [];
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const cur = all[i];
    const gap = Date.parse(cur.startTime) - Date.parse(prev.endTime);
    if (gap < GAP_MINUTES * 60 * 1000) {
      timeConflicts.push(`${prev.orderNo} ↔ ${cur.orderNo}`);
    }
  }

  const byDay = new Map<string, number>();
  for (const order of all) {
    byDay.set(dayKey(order), (byDay.get(dayKey(order)) ?? 0) + order.weight);
  }
  let overweight = 0;
  let day = "";
  let totalWeight = 0;
  for (const [d, w] of byDay) {
    if (w > MAX_DAILY_WEIGHT && w - MAX_DAILY_WEIGHT > overweight) {
      overweight = w - MAX_DAILY_WEIGHT;
      day = d;
      totalWeight = w;
    }
  }

  if (timeConflicts.length === 0 && overweight <= 0) return null;
  return { attemptOrderNo: candidate.orderNo, timeConflicts, overweight, day, totalWeight };
}

const blankForm = { orderNo: "", destination: "", weight: 0, startTime: "", endTime: "" };

export default function App() {
  const [records, setRecords] = useState<Order[]>(loadRecords);
  const [conflicts, setConflicts] = useState<Record<string, ConflictInfo>>({});
  const [form, setForm] = useState(blankForm);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");

  const pendingOrders = useMemo(
    () => records.filter((r) => r.status === "待分配").sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [records]
  );

  const ordersByDriver = useMemo(() => {
    const map = new Map<string, Order[]>();
    for (const driver of DRIVERS) {
      map.set(
        driver,
        records
          .filter((r) => r.driver === driver && occupiesDriver(r))
          .sort((a, b) => a.startTime.localeCompare(b.startTime))
      );
    }
    return map;
  }, [records]);

  // 每个司机按天统计累计重量
  const loadByDriver = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const driver of DRIVERS) map.set(driver, new Map());
    for (const order of records) {
      if (!order.driver || !occupiesDriver(order)) continue;
      const dayMap = map.get(order.driver)!;
      dayMap.set(dayKey(order), (dayMap.get(dayKey(order)) ?? 0) + order.weight);
    }
    return map;
  }, [records]);

  const metrics = useMemo(() => {
    const assigned = records.filter((r) => r.status !== "待分配").length;
    const totalWeight = records.filter(occupiesDriver).reduce((sum, r) => sum + r.weight, 0);
    return [records.length, assigned, totalWeight];
  }, [records]);

  const chartRows = STATUSES.map((status) => ({
    status,
    value: records.filter((r) => r.status === status).length
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  function updateRecords(next: Order[]) {
    setRecords(next);
    saveRecords(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.startTime || !form.endTime) {
      setFormError("请填写配送开始和结束时间");
      return;
    }
    if (Date.parse(form.endTime) <= Date.parse(form.startTime)) {
      setFormError("配送结束时间必须晚于开始时间");
      return;
    }
    if (!(form.weight > 0)) {
      setFormError("重量必须大于 0kg");
      return;
    }
    const next: Order = {
      ...form,
      id: crypto.randomUUID(),
      driver: "",
      status: "待分配",
      notes: note || "暂无备注",
      createdAt: new Date().toISOString()
    };
    updateRecords([next, ...records]);
    setForm(blankForm);
    setNote("");
    setFormError("");
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const order = records.find((r) => r.id === active.id);
    if (!order) return;
    // 已开始配送/已完成的订单不允许改派（拖拽本身已禁用，这里兜底）
    if (order.status !== "待分配" && order.status !== "已分配") return;

    const overId = String(over.id);

    if (overId === "pool") {
      // 拖回待分配池：释放原司机负荷
      if (order.driver) {
        updateRecords(records.map((r) => (r.id === order.id ? { ...r, driver: "", status: "待分配" } : r)));
      }
      return;
    }

    if (overId.startsWith("driver:")) {
      const driver = overId.slice("driver:".length);
      if (order.driver === driver) return;
      const driverOrders = records.filter((r) => r.driver === driver && r.id !== order.id && occupiesDriver(r));
      const conflict = checkAssignment(driverOrders, order);
      if (conflict) {
        // 超限：不派单，原排班保持不变，仅在该司机卡片下记录冲突
        setConflicts((prev) => ({ ...prev, [driver]: conflict }));
        return;
      }
      // 校验通过：改派成功，原司机负荷随 records 派生自动释放
      setConflicts((prev) => {
        const next = { ...prev };
        delete next[driver];
        return next;
      });
      updateRecords(records.map((r) => (r.id === order.id ? { ...r, driver, status: "已分配" } : r)));
    }
  }

  function advanceStatus(order: Order) {
    const next = order.status === "已分配" ? "配送中" : order.status === "配送中" ? "已完成" : order.status;
    if (next === order.status) return;
    updateRecords(records.map((r) => (r.id === order.id ? { ...r, status: next } : r)));
  }

  function removeOrder(order: Order) {
    updateRecords(records.filter((r) => r.id !== order.id));
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">物流行业前端最小闭环</p>
            <h1>配送任务拖拽排班</h1>
            <p className="subtitle">
              把待分配订单拖给司机：同一司机相邻两单至少间隔 {GAP_MINUTES} 分钟，单日累计重量不超过 {MAX_DAILY_WEIGHT}kg；超限则拒绝派单并保留原排班。
            </p>
          </div>
          <div className="stack">{["React", "Vite", "TypeScript", "dnd-kit", "localStorage"].map((item) => <span className="tag" key={item}>{item}</span>)}</div>
        </header>

        <section className="metrics">
          {["订单数", "已分配", "在途总重量kg"].map((label, index) => (
            <article className="metric" key={label}>
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
            </article>
          ))}
        </section>

        <section className="workspace">
          <form className="panel" onSubmit={handleSubmit}>
            <h2>新增待分配订单</h2>
            <div className="form-grid">
              <label>
                订单号
                <input value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} required placeholder="ORD-XXXX" />
              </label>
              <label>
                目的地
                <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} required />
              </label>
              <label>
                重量kg
                <input type="number" min={1} value={form.weight || ""} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} required />
              </label>
              <label>
                配送开始时间
                <input type="datetime-local" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required />
              </label>
              <label>
                配送结束时间
                <input type="datetime-local" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} required />
              </label>
              <label>
                备注
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填写处理说明或现场备注" />
              </label>
              {formError && <p className="form-error">{formError}</p>}
              <button type="submit">加入待分配</button>
            </div>
          </form>

          <DndContext collisionDetection={rectIntersection} onDragEnd={handleDragEnd}>
            <section className="board">
              <PoolColumn orders={pendingOrders} onAdvance={advanceStatus} onRemove={removeOrder} />
              <div className="drivers">
                {DRIVERS.map((driver) => (
                  <DriverColumn
                    key={driver}
                    driver={driver}
                    orders={ordersByDriver.get(driver) ?? []}
                    loads={loadByDriver.get(driver) ?? new Map()}
                    conflict={conflicts[driver]}
                    onDismissConflict={() =>
                      setConflicts((prev) => {
                        const next = { ...prev };
                        delete next[driver];
                        return next;
                      })
                    }
                    onAdvance={advanceStatus}
                    onRemove={removeOrder}
                  />
                ))}
              </div>
            </section>
          </DndContext>
        </section>

        <section className="list-panel">
          <div className="toolbar">
            <h2>状态分布</h2>
          </div>
          <div className="mini-chart">
            {chartRows.map((row) => (
              <div className="bar" key={row.status}>
                <span>{row.status}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} /></div>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function OrderCard({ order, onAdvance, onRemove }: { order: Order; onAdvance: (o: Order) => void; onRemove: (o: Order) => void }) {
  const draggable = order.status === "待分配" || order.status === "已分配";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: order.id, disabled: !draggable });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`record order-card${isDragging ? " dragging" : ""}${draggable ? "" : " locked"}`}
      {...(draggable ? { ...listeners, ...attributes } : {})}
    >
      <div className="record-head">
        <p className="record-title">{order.orderNo}</p>
        <span className={`status ${STATUS_CLASS[order.status] ?? ""}`}>{order.status}</span>
      </div>
      <div className="details">
        <span>目的地: {order.destination}</span>
        <span>重量: {order.weight}kg</span>
        <span>开始: {fmtTime(order.startTime)}</span>
        <span>结束: {fmtTime(order.endTime)}</span>
      </div>
      <p className="note">{order.notes}</p>
      {order.status === "配送中" && <p className="hint">已开始配送，不可改派</p>}
      <div className="actions">
        {order.status === "已分配" && (
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onAdvance(order)}>开始配送</button>
        )}
        {order.status === "配送中" && (
          <button type="button" onClick={() => onAdvance(order)}>完成配送</button>
        )}
        {order.status !== "配送中" && (
          <button className="danger" type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(order)}>删除</button>
        )}
      </div>
    </article>
  );
}

function PoolColumn({ orders, onAdvance, onRemove }: { orders: Order[]; onAdvance: (o: Order) => void; onRemove: (o: Order) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: "pool" });
  return (
    <div ref={setNodeRef} className={`pool${isOver ? " over" : ""}`}>
      <div className="toolbar">
        <h2>待分配订单（{orders.length}）</h2>
        <span className="hint">拖到右侧司机卡片进行派单</span>
      </div>
      <div className="record-grid">
        {orders.length === 0 ? <div className="empty">暂无待分配订单</div> : orders.map((order) => (
          <OrderCard key={order.id} order={order} onAdvance={onAdvance} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

function DriverColumn({
  driver,
  orders,
  loads,
  conflict,
  onDismissConflict,
  onAdvance,
  onRemove
}: {
  driver: string;
  orders: Order[];
  loads: Map<string, number>;
  conflict?: ConflictInfo;
  onDismissConflict: () => void;
  onAdvance: (o: Order) => void;
  onRemove: (o: Order) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `driver:${driver}` });
  const loadEntries = [...loads.entries()].sort();

  return (
    <div ref={setNodeRef} className={`driver-col${isOver ? " over" : ""}`}>
      <div className="driver-head">
        <h3>{driver}</h3>
        <span className="hint">{orders.length} 单</span>
      </div>

      <div className="loads">
        {loadEntries.length === 0 ? <span className="hint">当日无负荷</span> : loadEntries.map(([day, weight]) => (
          <div className="load-row" key={day}>
            <span>{day.slice(5)}</span>
            <div className="bar-track">
              <div
                className={`bar-fill${weight > MAX_DAILY_WEIGHT ? " over-limit" : ""}`}
                style={{ width: `${Math.min(100, (weight / MAX_DAILY_WEIGHT) * 100)}%` }}
              />
            </div>
            <strong className={weight > MAX_DAILY_WEIGHT ? "over-limit-text" : ""}>{weight}/{MAX_DAILY_WEIGHT}kg</strong>
          </div>
        ))}
      </div>

      {conflict && (
        <div className="conflict-box">
          <p className="conflict-title">派单失败：{conflict.attemptOrderNo} 未分配给 {driver}，原排班保持不变</p>
          {conflict.timeConflicts.length > 0 && (
            <p>时间冲突（相邻间隔不足 {GAP_MINUTES} 分钟）：{conflict.timeConflicts.join("；")}</p>
          )}
          {conflict.overweight > 0 && (
            <p>超重：{conflict.day.slice(5)} 当日 {conflict.totalWeight}kg / {MAX_DAILY_WEIGHT}kg，超出 {conflict.overweight}kg</p>
          )}
          <button className="secondary" type="button" onClick={onDismissConflict}>知道了</button>
        </div>
      )}

      <div className="record-grid">
        {orders.length === 0 ? <div className="empty">拖拽订单到此派单</div> : orders.map((order) => (
          <OrderCard key={order.id} order={order} onAdvance={onAdvance} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}
