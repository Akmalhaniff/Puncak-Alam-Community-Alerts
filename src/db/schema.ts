import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text, timestamp, doublePrecision, boolean } from 'drizzle-orm/pg-core';

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
  time: timestamp('time').defaultNow(),
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
