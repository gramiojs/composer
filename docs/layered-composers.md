# Слоистые Composer'ы: дедупликация и совместный доступ к данным

> Этот документ отвечает на вопрос: если `withUser` расширяется в нескольких
> Composer'ах, DB-запрос выполняется один или несколько раз?

---

## Что такое дедупликация (структурный уровень)

Каждый `Composer` с именем хранит `Set<string>` (`["~"].extended`) зарегистрированных
плагинов. При `extend()` вычисляется ключ `name:JSON.stringify(seed)`. Если ключ
уже есть — весь плагин пропускается на этапе регистрации:

```typescript
const withUser = new Composer({ name: "withUser" })
    .derive(async (ctx) => ({ user: await db.getUser(ctx.from?.id) }))
    .as("scoped");

const app = new Composer()
    .extend(withUser) // ✅ зарегистрирован, ключ "withUser:null" добавлен
    .extend(withUser); // ⏭️  ключ уже есть → extend() → return this; ничего не добавлено
```

Дедупликация **транзитивна**: если `adminRouter` уже расширил `withUser`,
то когда `app` расширяет `adminRouter`, ключ `"withUser:null"` переносится
в `app["~"].extended`. Последующий `.extend(withUser)` в `app` — no-op.

```typescript
const a = new Composer({ name: "a" }).use(mwA);
const b = new Composer({ name: "b" }).extend(a); // b.extended = {"a:null"}

const app = new Composer()
    .extend(b) // app.extended = {"b:null", "a:null"}
    .extend(a); // "a:null" уже есть → пропущено
```

Тесты: `tests/dedup.test.ts`.

---

## Isolation groups: почему данных может не быть

Дедупликация решает вопрос _количества регистраций_. Но есть второй вопрос:
**доступны ли данные derive другим Composer'ам в runtime?**

Ответ зависит от того, как работает `extend()` с middleware разных scope.

### Как extend() собирает middleware

При `parent.extend(other)` middleware `other` распределяются по трём группам и
добавляются к `parent` в следующем порядке:

| Scope в `other`        | Что происходит в `parent`                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `local` (по умолчанию) | Все local-middleware оборачиваются в **одну** isolation group через `Object.create(ctx)`. Результаты derive **не вытекают** в родителя. |
| `scoped`               | Добавляется как plain function (без изоляции) в parent как `local`. **Вытекает** в родителя.                                            |
| `global`               | Добавляется как `global`. **Вытекает** в родителя и все предки.                                                                         |

Изоляция через `Object.create`:

```typescript
// Что происходит с local middleware при extend():
const isolated = async (ctx, next) => {
    const scopedCtx = Object.create(ctx); // читает из ctx через proto, пишет в scopedCtx
    await chain(scopedCtx, noopNext); // derive пишет в scopedCtx, НЕ в ctx
    return next(); // ctx не изменён
};
```

Ключевой момент: **proto-chain работает в обе стороны**.

- Внутри isolation group — читаем `ctx.user` через proto ✅
- Снаружи isolation group — `ctx.user` не установлен ❌

---

## Сценарий: withUser в нескольких роутерах

Рассмотрим архитектуру из реального проекта:

```
bot
  .extend(adminRouter)   ← adminRouter.extend(withUser)
  .extend(chatRouter)    ← chatRouter.extend(withUser)
```

### Вариант A: без имени (нет дедупликации)

```typescript
const withUser = new Composer() // ← нет name!
    .decorate({ db })
    .derive(async (ctx) => ({ user: await db.getUser(ctx.from?.id) }));
```

**Middleware chain в bot:**

```
[ isolated_admin([decorate, derive, adminHandlers]),
  isolated_chat([decorate, derive, chatHandlers]) ]
```

При выполнении: **два DB-запроса** (один в каждой isolation group).
`ctx.user` доступен в каждой группе, но работа делается дважды.

---

---

> [!WARNING]
> **Dedup ≠ shared data.**
>
> Дедупликация по имени убирает middleware из цепочки на этапе _регистрации_.
> Но если derive уже был обёрнут в isolation group первого роутера,
> его результат (`ctx.user`) **не доступен** второму роутеру — даже если derive
> выполнился ровно один раз.
>
> TypeScript при этом молчит: типы правильные, runtime — нет.
> Это единственный случай в библиотеке, где типы и поведение расходятся.
>
> **Решение:** расширяйте общий Composer на том уровне, где нужны данные,
> а в sub-composerах — только для типов (dedup позаботится о runtime).

### Вариант B: с именем, дедупликация работает, но есть gotcha

```typescript
const withUser = new Composer({ name: "withUser" })
    .decorate({ db })
    .derive(async (ctx) => ({ user: await db.getUser(ctx.from?.id) }))
    .as("scoped");
```

**Трассировка `bot.extend(adminRouter)`:**

1. `adminRouter` имеет middlewares: `[decorate (local, plugin:"withUser"), derive (local, plugin:"withUser"), adminHandlers (local)]`
2. `bot.extend(adminRouter)` → `bot.extended = {"adminRouter:null", "withUser:null"}`
3. Все local → одна isolation group: `isolated_admin([decorate, derive, adminHandlers])`

**Трассировка `bot.extend(chatRouter)`:**

1. `chatRouter` имеет `[decorate (local, plugin:"withUser"), derive (local, plugin:"withUser"), chatHandlers (local)]`
2. `bot.extended` уже содержит `"withUser:null"` → `isNew()` для `plugin:"withUser"` = `false`
3. `decorate` и `derive` **пропускаются** (dedup)
4. Только `chatHandlers` → isolation group: `isolated_chat([chatHandlers])`

**Итоговая chain в bot:**

```
[ isolated_admin([decorate, derive, adminHandlers]),
  isolated_chat([chatHandlers]) ]   ← derive убран дедупликацией
```

**Runtime при обработке обновления:**

```
ctx = { from: { id: 123 } }
         │
         ▼
isolated_admin:
  scopedCtx = Object.create(ctx)
  decorate  → scopedCtx.db   = dbClient  ✅
  derive    → scopedCtx.user = { id: 123, name: "Alice", role: "admin" }  ✅
  adminHandlers(scopedCtx) — видят ctx.user, ctx.db  ✅
  [если handler вызывает next()]
         │
         ▼
isolated_chat:
  scopedCtx2 = Object.create(ctx)   ← ctx.user не установлен!
  chatHandlers(scopedCtx2) — ctx2.user = undefined  ❌
```

**Один DB-запрос ✅, но chatHandlers не видят ctx.user ❌.**

Дедупликация выполнила свою работу структурно, но данные изолированы в первой group.

---

## Когда gotcha НЕ проявляется

Для большинства Telegram-ботов эта проблема не критична, потому что роутеры
**взаимоисключающие**: каждое обновление обрабатывается одним роутером.

```typescript
const adminRouter = new Composer()
    .extend(withUser)
    .guard((ctx) => ctx.user.role === "admin") // не-admin → chain останавливается
    .command("ban", handler); // handler НЕ вызывает next()

const chatRouter = new Composer().extend(withUser).on("message", handler); // handler НЕ вызывает next()
```

Если adminRouter обработал команду — до chatRouter очередь не доходит.
Если adminRouter пропустил (пользователь не admin) — chatRouter обрабатывает.
В обоих случаях в runtime работает **одна** isolation group на запрос.

> ⚠️ Проблема возникает только если **оба** роутера вызывают `next()` для одного
> обновления. Тогда chatHandlers не увидят `ctx.user`.

---

## Правильный паттерн: extend withUser на верхнем уровне

Чтобы `ctx.user` был доступен во **всех** роутерах независимо от порядка обработки:

```typescript
const withUser = new Composer({ name: "withUser" })
    .decorate({ db })
    .derive(async (ctx) => ({ user: await db.getUser(ctx.from?.id) }))
    .as("scoped"); // scoped → добавляется как plain fn в parent, без изоляции

// Роутеры расширяют withUser для TYPE SAFETY
const adminRouter = new Composer({ name: "adminRouter" })
    .extend(withUser) // ctx.user типизирован ✅
    .guard((ctx) => ctx.user.role === "admin")
    .command("ban", handler);

const chatRouter = new Composer({ name: "chatRouter" })
    .extend(withUser) // ctx.user типизирован ✅
    .on("message", (ctx) => ctx.send(ctx.user.name));

// Bot расширяет withUser ПЕРВЫМ
const bot = new Composer()
    .extend(withUser) // ← derive становится plain fn в bot, выполняется на реальном ctx
    .extend(adminRouter) // dedup: withUser из adminRouter → ПРОПУСКАЕТСЯ
    .extend(chatRouter); // dedup: withUser из chatRouter → ПРОПУСКАЕТСЯ
```

**Итоговая chain в bot:**

```
[ decorate.fn,           ← из withUser (scoped→local plain fn, без изоляции)
  derive.fn,             ← из withUser (scoped→local plain fn, без изоляции)
  isolated_admin([adminHandlers]),
  isolated_chat([chatHandlers]) ]
```

**Runtime:**

```
ctx = { from: { id: 123 } }
         │
         ▼
decorate(ctx) → ctx.db   = dbClient         ✅ на реальном ctx
derive(ctx)   → ctx.user = { id: 123, ... } ✅ на реальном ctx
         │
         ▼
isolated_admin:
  scopedCtx = Object.create(ctx)
  adminHandlers — scopedCtx.user via proto chain ✅
         │
         ▼
isolated_chat:
  scopedCtx2 = Object.create(ctx)
  chatHandlers — scopedCtx2.user via proto chain ✅
```

**Один DB-запрос ✅, ctx.user доступен везде ✅.**

Ключевое свойство: `Object.create(ctx)` создаёт объект с `ctx` как прототипом.
Чтение `scopedCtx.user` прозрачно проходит по proto-chain к `ctx.user`.

---

## Итоговая таблица паттернов

| Паттерн                       | DB-запросы/запрос     | ctx.user в 2-м роутере | Когда использовать        |
| ----------------------------- | --------------------- | ---------------------- | ------------------------- |
| Без имени, only sub-composers | N (по числу роутеров) | ✅ да                  | Никогда (дорого)          |
| С именем, only sub-composers  | 0 или 1               | ❌ нет (изоляция)      | Взаимоисключающие роутеры |
| С именем, extend на top level | 1                     | ✅ да (proto chain)    | Shared context для всех   |

---

## Быстрая проверка для вашей архитектуры

**Вопрос 1: Могут ли оба роутера обрабатывать одно обновление?**

- Нет → роутеры взаимоисключающие → проблемы нет, можно не менять структуру
- Да → нужен extend на top level

**Вопрос 2: Есть ли у withUser имя?**

- Нет → дедупликации нет → DB-запрос выполняется N раз → добавьте `{ name: "withUser" }`
- Да → дедупликация работает → см. вопрос 1

**Вопрос 3: Нужна ли `ctx.user` только внутри sub-composer или снаружи тоже?**

- Только внутри → `local` scope (по умолчанию), изоляция защищает от утечек
- В parent и siblings → `scoped` + extend withUser на level выше

---

## Полный рабочий пример (правильная архитектура)

```typescript
// middleware/user.ts
export const db = {
    getUser: (id: number) =>
        Promise.resolve({ id, name: "Alice", role: "admin" as const }),
    getChat: (id: number) =>
        Promise.resolve({ id, title: "Мой чат", language: "ru" }),
};

export const withUser = new Composer({ name: "withUser" })
    .decorate({ db })
    .derive(async (ctx) => ({
        user: await db.getUser(ctx.from?.id ?? 0),
    }))
    .as("scoped"); // ← propagates to parent, no isolation

// routers/admin.ts
export const adminRouter = new Composer({ name: "adminRouter" })
    .extend(withUser) // типы ✅, runtime: skipped если bot уже extends withUser
    .guard((ctx) => ctx.user.role === "admin") // ctx.user типизирован
    .command("ban", (ctx) => ctx.send(`Забанен! (от ${ctx.user.name})`))
    .command("kick", (ctx) => ctx.send("Кикнут!"))
    .command("stats", async (ctx) => {
        const target = await ctx.db.getUser(42);
        ctx.send(`Статистика для: ${target.name}`);
    });

// routers/chat.ts
const withChat = new Composer({ name: "withChat" })
    .derive(async (ctx: any) => ({
        chatRecord: await db.getChat(ctx.chat?.id ?? 0),
    }))
    .as("scoped");

export const chatRouter = new Composer({ name: "chatRouter" })
    .extend(withUser) // типы ✅
    .extend(withChat) // типы ✅
    .on("message", (ctx) => {
        ctx.send(`${ctx.user.name} в ${ctx.chatRecord.title}`);
    });

// bot.ts
const bot = new Bot(process.env.BOT_TOKEN)
    .extend(withUser) // ← ПЕРВЫМ: derive на реальном ctx, один раз на запрос
    .extend(adminRouter) // dedup: withUser из adminRouter пропускается
    .extend(chatRouter) // dedup: withUser из chatRouter пропускается
    .command("start", (ctx) => ctx.send("Привет!"));
```

### Что видит каждый слой

| Слой                       | `ctx.user` | `ctx.db` | `ctx.chatRecord` | Guard                 |
| -------------------------- | ---------- | -------- | ---------------- | --------------------- |
| `bot` (global)             | ✅         | ✅       | —                | —                     |
| `adminRouter`              | ✅         | ✅       | —                | user.role === "admin" |
| `chatRouter` (message)     | ✅         | ✅       | ✅               | —                     |
| `chatRouter` (другие типы) | ✅         | ✅       | partial          | —                     |

DB-запрос выполняется **ровно один раз** на каждое входящее обновление.

---

Нет никакой единой runtime-цепочки, которую обходят все обработчики. Есть одна скомпилированная функция на маршрут. Дедупликация (checksum по name + seed) гарантирует, что withUser.derive попадёт в эту функцию ровно один раз — и всё.

Почему этот подход неприменим к event-based системам

HTTP-маршрут: один запрос → один обработчик. POST /ban никогда не попадёт в GET /profile. Isolation groups не нужны — у каждого маршрута своя вселенная.

Telegram-бот: одно обновление → потенциально несколько обработчиков в последовательной цепочке. Сообщение /start проходит сквозь adminRouter (не-admin → пропускает), chatRouter (не подходит → пропускает), bot.command("start") (ловит). Все три "раздела" работают с одним ctx в одной
цепочке.

Именно поэтому нужны isolation groups — чтобы derive-результаты из adminRouter не "утекали" в chatRouter и не ломали ожидания локальной области видимости.

Что мы могли бы взять у Elysia

Единственная идея, которая переносится — это per-route / per-event-type isolation: вместо одной flat-цепочки компилировать отдельную цепочку под каждый тип события. Тогда withUser попадал бы в chain message один раз и всё работало бы как в Elysia.

route() в composer уже делает это для явных dispatch-точек:

// Этот паттерн — аналог Elysia's per-route
bot.route(ctx => ctx.updateType, {
message: chatRouter, // ← отдельная скомпилированная цепочка
callback_query: cbRouter, // ← своя цепочка
});

Здесь isolation-проблемы нет — chatRouter получает управление один раз, withUser внутри него выполняется ровно раз, данные доступны внутри этой цепочки.

Вывод: Elysia не "решает" ту же проблему — она её обходит другой топологией (один запрос = одна цепочка = один путь данных). Для вашей архитектуры правильные варианты:

1. Extend withUser на top level — описано в документе
2. Использовать route() для диспетчеризации — аналог per-route компиляции Elysia, тогда isolation-проблема не возникает в принципе
3. Per-request мемоизация — если хочется сохранить текущую структуру, нужно дополнительное поле в composer (идея в конце документа)

## Что сейчас не поддерживается

**Мемоизация на уровне запроса без изменения архитектуры.**

Если вы не хотите расширять `withUser` на top level, альтернативой была бы
автоматическая мемоизация результата derive по ключу функции для одного и того же
request-context. Это позволило бы писать:

```typescript
// ← withUser НЕ на top level
bot.extend(adminRouter).extend(chatRouter);
// derive в adminRouter: выполняется, результат кешируется в ctx
// derive в chatRouter: видит кеш, возвращает без DB-запроса
```

Для реализации понадобился бы:

1. Идентификатор derive-функции (уже есть: `fn.name`)
2. Кеш результатов на объекте ctx (`WeakMap<ctx, Map<fnKey, result>>`)
3. Проверка кеша перед вызовом обработчика в derive wrapper

Это изменение затронет `composer.ts:derive()` и потребует нового поля в context.
Если такой механизм нужен — откройте issue.
