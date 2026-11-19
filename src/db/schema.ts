import { relations } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text, timestamp, doublePrecision, boolean, customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const reports = pgTable('reports', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  type: text('type').notNull(), // 'flood', 'road', 'weather'
  status: text('status').notNull(), // 'danger', 'uncertain', 'clear'
  area: text('area').notNull(),
  details: text('details').notNull(),
  who: text('who'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  approximate: boolean('approximate').default(true),
  waterLevel: text('water_level'), // 'ankle' | 'knee' | 'waist' | 'car' (flood reports only)
  reviewed: boolean('reviewed').default(false), // admin checked it after flags; never auto-hidden again
  time: timestamp('time').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
});

// One optional photo per report, stored compressed (JPEG, metadata stripped). Deleted with its report.
export const reportPhotos = pgTable('report_photos', {
  reportId: integer('report_id').primaryKey().references(() => reports.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  thumb: bytea('thumb').notNull(),
  fullImage: bytea('full_image').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// "I see it too" votes: one per voter per report. voter_key is a Google uid or a salted hash, never a raw IP.
export const reportConfirmations = pgTable('report_confirmations', {
  reportId: integer('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
  voterKey: text('voter_key').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [primaryKey({ columns: [t.reportId, t.voterKey] })]);

// "Dah surut" (now clear) votes: one per voter per report. A flood report is only marked clear after enough votes.
export const reportClearVotes = pgTable('report_clear_votes', {
  reportId: integer('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
  voterKey: text('voter_key').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [primaryKey({ columns: [t.reportId, t.voterKey] })]);

// "Report a problem" flags: one per voter per report. Enough flags hide the report until the admin reviews it.
export const reportFlags = pgTable('report_flags', {
  reportId: integer('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
  voterKey: text('voter_key').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [primaryKey({ columns: [t.reportId, t.voterKey] })]);

// Flood-prone spots shown on the map; edited by the admin.
export const hotspots = pgTable('hotspots', {
  id: serial('id').primaryKey(),
  nameMs: text('name_ms').notNull(),
  nameEn: text('name_en').notNull(),
  noteMs: text('note_ms').notNull().default(''),
  noteEn: text('note_en').notNull().default(''),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  days: integer('days').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Phones that asked to be told about floods within radius_km of a point.
export const pushSubscriptions = pgTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  radiusKm: integer('radius_km').notNull(),
  lang: text('lang').notNull().default('ms'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  reports: many(reports),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  author: one(users, {
    fields: [reports.userId],
    references: [users.id],
  }),
}));
