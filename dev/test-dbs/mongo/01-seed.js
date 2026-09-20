/* eslint-disable */
/**
 * Mongo seed for test-mongodb-a.
 *
 * Runs automatically the first time the container starts (docker-entrypoint-
 * initdb.d hook). Populates `testdb` with 5 collections + ~5300 documents
 * total across realistic shapes.
 *
 * We intentionally introduce variation:
 *   • 10% of `users` are missing optional fields (sparse schema)
 *   • 5% of `users` store `age` as a string instead of a number
 *   • Nested objects in every document
 *   • Arrays of objects (orders.items, products.ratings)
 *   • Mix of `null` and missing fields for the migration coercion logic
 *
 * Counts are documented per the project spec — Part 2 of the migration test plan.
 */

print('[seed] Switching to testdb…');
db = db.getSiblingDB('testdb');

// ── 0. Determinism helpers ────────────────────────────────────────────────────
// We use a small linear-congruential RNG so reruns produce the same data;
// this keeps migration verifications reproducible across machines.
let _rngState = 1337;
function rand() {
  _rngState = (_rngState * 1664525 + 1013904223) % 0x100000000;
  return _rngState / 0x100000000;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function int(min, max) { return Math.floor(min + rand() * (max - min + 1)); }
function float(min, max, decimals = 2) {
  const v = min + rand() * (max - min);
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}
function bool() { return rand() < 0.5; }
function maybeNull(v, pNull = 0.1) { return rand() < pNull ? null : v; }
function uuidLike() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(rand() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const CITIES   = ['Delhi', 'Mumbai', 'London', 'NYC', 'Berlin', 'Tokyo', 'Paris', 'Sydney', 'Toronto'];
const COUNTRIES = ['IN', 'UK', 'US', 'DE', 'JP', 'FR', 'AU', 'CA'];
const TAGS     = ['vip', 'beta', 'enterprise', 'student', 'trial', 'pro', 'free', 'partner', 'staff', 'inactive'];
const CATS     = ['Electronics', 'Clothing', 'Books', 'Home', 'Sports', 'Toys', 'Beauty', 'Auto'];
const COLORS   = ['red', 'blue', 'green', 'black', 'white', 'silver', 'gold'];
const MATS     = ['plastic', 'metal', 'wood', 'fabric', 'glass'];
const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];
const LOG_LEVELS = ['info', 'warn', 'error', 'debug'];
const SERVICES = ['api', 'worker', 'auth', 'billing', 'notif'];
const DEVICES  = ['desktop', 'mobile', 'tablet'];
const EVENTS   = ['page_view', 'click', 'signup', 'purchase', 'logout', 'search'];

// ── 1. users (500) ────────────────────────────────────────────────────────────
print('[seed] users…');
db.users.drop();
const userIds = [];
const userDocs = [];
for (let i = 1; i <= 500; i++) {
  const id = new ObjectId();
  userIds.push(id);

  // Base doc
  const doc = {
    _id: id,
    name: 'User ' + i,
    email: 'user' + i + '@test.com',
    // 5% of docs intentionally store age as a STRING to exercise mixed-type detection.
    age: rand() < 0.05 ? String(int(18, 80)) : int(18, 80),
    address: {
      city: pick(CITIES),
      country: pick(COUNTRIES),
      zip: String(10000 + i).padStart(6, '0'),
      geo: { lat: float(-90, 90, 6), lng: float(-180, 180, 6) },
    },
    tags: [pick(TAGS), pick(TAGS), pick(TAGS)],
    isActive: bool(),
    score: float(0, 100),
    metadata: {
      loginCount: int(0, 500),
      lastLogin: new Date(Date.now() - int(0, 30) * 86400 * 1000),
      preferences: {
        theme: bool() ? 'dark' : 'light',
        lang: pick(['en', 'es', 'fr', 'de', 'ja']),
      },
    },
    createdAt: new Date(Date.now() - int(0, 365) * 86400 * 1000),
  };

  // 10% of docs drop some optional fields (sparse schema).
  if (rand() < 0.1) {
    delete doc.score;
    delete doc.tags;
  }
  if (rand() < 0.05) delete doc.metadata.preferences;

  userDocs.push(doc);
}
db.users.insertMany(userDocs);
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ 'address.country': 1 });
print('[seed] users: ' + db.users.countDocuments());

// ── 2. products (300) ─────────────────────────────────────────────────────────
print('[seed] products…');
db.products.drop();
const productIds = [];
const productDocs = [];
for (let i = 1; i <= 300; i++) {
  const id = new ObjectId();
  productIds.push(id);
  // Each product has 0-5 ratings, each referencing a real user.
  const numRatings = int(0, 5);
  const ratings = [];
  for (let r = 0; r < numRatings; r++) {
    ratings.push({
      userId: userIds[int(0, userIds.length - 1)],
      score: int(1, 5),
      comment: 'Comment ' + r + ' for product ' + i,
    });
  }
  productDocs.push({
    _id: id,
    name: 'Product ' + i,
    category: pick(CATS),
    price: float(1, 1000),
    stock: int(0, 500),
    specs: {
      weight: float(0.1, 10),
      dimensions: { w: float(1, 50), h: float(1, 50), d: float(1, 50) },
      color: pick(COLORS),
      material: pick(MATS),
    },
    images: [
      'https://cdn.example.com/p' + i + '/1.jpg',
      'https://cdn.example.com/p' + i + '/2.jpg',
    ],
    ratings,
    isAvailable: rand() > 0.1,
    createdAt: new Date(Date.now() - int(0, 365) * 86400 * 1000),
  });
}
db.products.insertMany(productDocs);
db.products.createIndex({ category: 1, price: -1 });
print('[seed] products: ' + db.products.countDocuments());

// ── 3. orders (1000) ──────────────────────────────────────────────────────────
print('[seed] orders…');
db.orders.drop();
const orderDocs = [];
for (let i = 1; i <= 1000; i++) {
  const userId = userIds[int(0, userIds.length - 1)];
  const numItems = int(1, 4);
  const items = [];
  let total = 0;
  for (let k = 0; k < numItems; k++) {
    const pid = productIds[int(0, productIds.length - 1)];
    const qty = int(1, 5);
    const price = float(5, 200);
    items.push({ productId: pid, name: 'Item ' + k, qty, price });
    total += qty * price;
  }
  orderDocs.push({
    _id: new ObjectId(),
    userId,
    items,
    total: Math.round(total * 100) / 100,
    status: pick(ORDER_STATUSES),
    shippingAddress: {
      city: pick(CITIES),
      country: pick(COUNTRIES),
      zip: String(20000 + i).padStart(6, '0'),
      geo: { lat: float(-90, 90, 6), lng: float(-180, 180, 6) },
    },
    notes: maybeNull('Order note ' + i, 0.4), // 40% null
    createdAt: new Date(Date.now() - int(0, 90) * 86400 * 1000),
    updatedAt: new Date(),
  });
}
db.orders.insertMany(orderDocs);
db.orders.createIndex({ userId: 1, createdAt: -1 });
db.orders.createIndex({ status: 1 });
print('[seed] orders: ' + db.orders.countDocuments());

// ── 4. logs (2000) ────────────────────────────────────────────────────────────
print('[seed] logs…');
db.logs.drop();
const logBatch = [];
for (let i = 1; i <= 2000; i++) {
  logBatch.push({
    _id: new ObjectId(),
    level: pick(LOG_LEVELS),
    message: 'Log message ' + i,
    timestamp: new Date(Date.now() - int(0, 30) * 86400 * 1000),
    service: pick(SERVICES),
    userId: maybeNull(userIds[int(0, userIds.length - 1)], 0.3),
    metadata: {
      ip: int(1, 255) + '.' + int(1, 255) + '.' + int(1, 255) + '.' + int(1, 255),
      userAgent: 'Mozilla/5.0 (test/' + i + ')',
      duration: int(1, 5000),
    },
    tags: [pick(TAGS), pick(TAGS)],
  });
  if (logBatch.length === 500) {
    db.logs.insertMany(logBatch);
    logBatch.length = 0;
  }
}
if (logBatch.length) db.logs.insertMany(logBatch);
db.logs.createIndex({ timestamp: -1 });
db.logs.createIndex({ level: 1, service: 1 });
print('[seed] logs: ' + db.logs.countDocuments());

// ── 5. analytics (1500) ───────────────────────────────────────────────────────
print('[seed] analytics…');
db.analytics.drop();
const evtBatch = [];
for (let i = 1; i <= 1500; i++) {
  evtBatch.push({
    _id: new ObjectId(),
    event: pick(EVENTS),
    userId: maybeNull(userIds[int(0, userIds.length - 1)], 0.2),
    sessionId: uuidLike(),
    properties: {
      page: '/page/' + int(1, 50),
      referrer: rand() < 0.5 ? 'https://google.com' : 'https://twitter.com',
      device: pick(DEVICES),
    },
    timestamp: new Date(Date.now() - int(0, 14) * 86400 * 1000),
    value: maybeNull(float(0, 1000), 0.3),
  });
  if (evtBatch.length === 500) {
    db.analytics.insertMany(evtBatch);
    evtBatch.length = 0;
  }
}
if (evtBatch.length) db.analytics.insertMany(evtBatch);
db.analytics.createIndex({ event: 1, timestamp: -1 });
print('[seed] analytics: ' + db.analytics.countDocuments());

print('[seed] Done. Total: ' + (
  db.users.countDocuments() + db.products.countDocuments() +
  db.orders.countDocuments() + db.logs.countDocuments() +
  db.analytics.countDocuments()
) + ' documents across 5 collections.');
