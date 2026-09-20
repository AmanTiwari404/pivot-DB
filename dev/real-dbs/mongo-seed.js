// 65k+ documents across 4 collections
const N_USERS = 10000, N_PRODUCTS = 5000, N_ORDERS = 20000, N_LOGS = 30000;

db = db.getSiblingDB('realtest');
db.users.drop(); db.products.drop(); db.orders.drop(); db.logs.drop();

const pick = a => a[Math.floor(Math.random() * a.length)];
const cities = ['NYC', 'LA', 'Chicago', 'Houston', 'Phoenix', 'Philly', 'SF', 'Seattle', 'Boston', 'Austin'];
const tiers = ['free', 'pro', 'enterprise'];

print('seeding users...');
let batch = [];
for (let i = 0; i < N_USERS; i++) {
    batch.push({
        _id: i + 1, email: `user${i + 1}@example.com`, name: `User ${i + 1}`,
        tier: pick(tiers), city: pick(cities),
        age: 18 + Math.floor(Math.random() * 60),
        active: Math.random() > 0.2,
        tags: Math.random() > 0.5 ? ['beta', 'newsletter'].slice(0, 1 + Math.floor(Math.random() * 2)) : null,
        createdAt: new Date(Date.now() - Math.random() * 1e10),
    });
    if (batch.length === 1000) { db.users.insertMany(batch); batch = []; }
}
if (batch.length) db.users.insertMany(batch);

print('seeding products...');
batch = [];
for (let i = 0; i < N_PRODUCTS; i++) {
    batch.push({
        _id: i + 1, sku: `SKU-${i + 1}`, name: `Product ${i + 1}`,
        price: +(Math.random() * 500).toFixed(2),
        stock: Math.floor(Math.random() * 1000),
        category: pick(['electronics', 'books', 'clothing', 'home', 'toys']),
        inStock: Math.random() > 0.1,
    });
    if (batch.length === 1000) { db.products.insertMany(batch); batch = []; }
}
if (batch.length) db.products.insertMany(batch);

print('seeding orders...');
batch = [];
for (let i = 0; i < N_ORDERS; i++) {
    batch.push({
        _id: i + 1,
        userId: 1 + Math.floor(Math.random() * N_USERS),
        productId: 1 + Math.floor(Math.random() * N_PRODUCTS),
        qty: 1 + Math.floor(Math.random() * 5),
        total: +(Math.random() * 1000).toFixed(2),
        status: pick(['pending', 'shipped', 'delivered', 'cancelled']),
        placedAt: new Date(Date.now() - Math.random() * 1e10),
    });
    if (batch.length === 2000) { db.orders.insertMany(batch); batch = []; }
}
if (batch.length) db.orders.insertMany(batch);

print('seeding logs...');
batch = [];
for (let i = 0; i < N_LOGS; i++) {
    batch.push({
        level: pick(['info', 'warn', 'error', 'debug']),
        message: `log entry ${i + 1}`,
        ts: new Date(Date.now() - Math.random() * 1e10),
        meta: Math.random() > 0.5 ? { ip: '10.0.0.' + Math.floor(Math.random() * 255) } : null,
    });
    if (batch.length === 2000) { db.logs.insertMany(batch); batch = []; }
}
if (batch.length) db.logs.insertMany(batch);

print('done. counts:');
printjson({
    users: db.users.countDocuments(),
    products: db.products.countDocuments(),
    orders: db.orders.countDocuments(),
    logs: db.logs.countDocuments(),
});