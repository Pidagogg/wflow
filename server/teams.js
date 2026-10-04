// ============================================================================
// W FLOW — custom Team plan (cloud side)
//
// Next to the flat Pro subscription there is a custom plan: the buyer chooses
// how many accounts it covers (seats). It cannot be bought straight away:
//
//   1. request    the buyer sends seats + company + a note from the Pro page;
//                 an e-mail goes to the operator (TEAM_REQUESTS_EMAIL, default
//                 main@w-flow.tech)
//   2. decision   the operator approves it in the admin panel (Team plans tab)
//                 with a monthly price, or declines it; the buyer is e-mailed
//   3. purchase   the buyer pays by card (Stripe, price_data with that price)
//                 or the operator marks it paid by hand (invoice / transfer)
//   4. active     the buyer and every member e-mail they list are Pro in the
//                 cloud; the buyer's licence key carries plan "team" + seats,
//                 which makes the buyer the admin of their self-hosted copy
//                 (server/team-admin.js) with room for that many accounts
//
// The team ends with the buyer's subscription (Stripe status) or, for a team
// paid by hand, at paidUntil. Teams are few, so they live as one JSON list in
// the settings store — no schema change on either database.
// ============================================================================
import { randomUUID } from "node:crypto";
import { db } from "./dbx.js";
import { sendMail } from "./mail.js";

const LIST_KEY = "teams.list";
export const MIN_SEATS = 2;
export const MAX_SEATS = 500;
/** Price suggested to the operator per seat and month (EUR) — Pro's own price. */
export const SUGGESTED_SEAT_PRICE = 9.99;
const ACTIVE_SUB = new Set(["active", "trialing"]);

export function teamRequestsEmail() {
  return String(process.env.TEAM_REQUESTS_EMAIL || "main@w-flow.tech").trim();
}

// ---- storage ----

export async function listTeams() {
  try {
    const list = JSON.parse((await db.storeGet(LIST_KEY)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveTeams(list) {
  await db.storeSet(LIST_KEY, JSON.stringify(list));
}

async function updateTeam(id, patch) {
  const list = await listTeams();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
  await saveTeams(list);
  return list[i];
}

export async function getTeam(id) {
  return (await listTeams()).find((t) => t.id === id) || null;
}

/** The account's own team request / plan — the newest one that is not closed. */
export async function teamOwnedBy(userId) {
  const mine = (await listTeams()).filter((t) => t.ownerId === String(userId));
  return mine.find((t) => t.status !== "rejected" && t.status !== "ended") || mine[mine.length - 1] || null;
}

// ---- state ----

/** A paid, running team: marked paid until a date, or backed by a live Stripe subscription. */
export async function teamActive(team) {
  if (!team || team.status !== "active") return false;
  if (Number(team.paidUntil || 0) > Date.now()) return true;
  if (!team.subscriptionId) return false;
  const sub = await db.getSubscription(team.ownerId);
  return sub?.subscription_id === team.subscriptionId && ACTIVE_SUB.has(String(sub.status));
}

function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

/**
 * What the account gets from a team: the owner holds the plan (team + seats),
 * a listed member is Pro. → { pro, plan, seats } or null.
 */
export async function teamEntitlement(user) {
  if (!user) return null;
  const email = normEmail(user.email);
  for (const team of await listTeams()) {
    if (team.status !== "active") continue;
    const isOwner = team.ownerId === String(user.id);
    const isMember = !isOwner && email && (team.members || []).includes(email);
    if (!isOwner && !isMember) continue;
    if (!(await teamActive(team))) continue;
    return isOwner ? { pro: true, plan: "team", seats: team.seats } : { pro: true, plan: "pro", seats: 1 };
  }
  return null;
}

/** The view of a team its owner sees on the Pro page. */
export async function teamView(team) {
  if (!team) return null;
  return {
    id: team.id,
    status: team.status,
    active: await teamActive(team),
    seats: team.seats,
    company: team.company,
    message: team.message,
    priceMonthly: team.priceMonthly || 0,
    currency: team.currency || "eur",
    note: team.note || "",
    members: team.members || [],
    paidUntil: team.paidUntil || 0,
    createdAt: team.createdAt,
  };
}

// ---- 1. request ----

export async function requestTeam(user, { seats, company, message } = {}, { adminUrl = "" } = {}) {
  const n = Math.floor(Number(seats));
  if (!Number.isFinite(n) || n < MIN_SEATS || n > MAX_SEATS) {
    return { ok: false, error: `Choose between ${MIN_SEATS} and ${MAX_SEATS} accounts.` };
  }
  const existing = await teamOwnedBy(user.userId);
  if (existing && ["pending", "approved", "active"].includes(existing.status)) {
    return { ok: false, error: existing.status === "active" ? "You already have a Team plan." : "You already sent a request — we will answer it by e-mail." };
  }
  const team = {
    id: `team-${randomUUID().slice(0, 8)}`,
    ownerId: String(user.userId),
    ownerEmail: normEmail(user.email),
    ownerName: String(user.name || "").slice(0, 120),
    company: String(company || "").trim().slice(0, 160),
    message: String(message || "").trim().slice(0, 2000),
    seats: n,
    status: "pending",
    priceMonthly: 0,
    currency: "eur",
    members: [],
    note: "",
    paidUntil: 0,
    subscriptionId: "",
    createdAt: new Date().toISOString(),
  };
  await saveTeams([...(await listTeams()), team]);
  const suggested = (n * SUGGESTED_SEAT_PRICE).toFixed(2);
  await sendMail({
    to: teamRequestsEmail(),
    subject: `W flow — Team plan request: ${n} accounts from ${team.ownerEmail}`,
    text: [
      "A new custom Team plan was requested. It can only be bought after you confirm it.",
      "",
      `Account:   ${team.ownerName ? `${team.ownerName} <${team.ownerEmail}>` : team.ownerEmail}`,
      `Company:   ${team.company || "—"}`,
      `Accounts:  ${n}`,
      `Suggested: €${suggested} / month (${n} × €${SUGGESTED_SEAT_PRICE})`,
      "",
      "Message:",
      team.message || "—",
      "",
      `Approve it with a price, or decline it, in the admin panel → Team plans${adminUrl ? `: ${adminUrl}` : "."}`,
      `Request id: ${team.id}`,
    ].join("\n"),
  });
  return { ok: true, team: await teamView(team) };
}

// ---- 2. decision (admin) ----

export async function decideTeam(id, { approve, priceMonthly, note } = {}, { siteUrl = "" } = {}) {
  const team = await getTeam(id);
  if (!team) return { ok: false, error: "Team request not found." };
  if (team.status !== "pending" && team.status !== "approved") return { ok: false, error: `This request is already ${team.status}.` };
  const price = Math.round(Number(priceMonthly) * 100) / 100;
  if (approve && !(price >= 1)) return { ok: false, error: "Set the monthly price (EUR) before approving." };
  const next = await updateTeam(id, {
    status: approve ? "approved" : "rejected",
    priceMonthly: approve ? price : team.priceMonthly,
    note: String(note || "").trim().slice(0, 1000),
    decidedAt: new Date().toISOString(),
  });
  const link = siteUrl ? `${siteUrl.replace(/\/+$/, "")}/subscription` : "the Pro page";
  await sendMail({
    to: team.ownerEmail,
    subject: approve ? "W flow — your Team plan is ready to buy" : "W flow — about your Team plan request",
    text: approve
      ? [
          `Your Team plan for ${team.seats} accounts was approved at €${price.toFixed(2)} per month.`,
          next.note ? `\n${next.note}\n` : "",
          `Complete the purchase on ${link}.`,
        ].join("\n")
      : [`We could not approve your Team plan request for ${team.seats} accounts.`, next.note ? `\n${next.note}` : "", "", "Reply to this e-mail if you have questions."].join("\n"),
  });
  return { ok: true, team: next };
}

/** Operator marks a team as paid by hand (invoice, bank transfer) for N months. */
export async function markTeamPaid(id, { months = 1 } = {}) {
  const team = await getTeam(id);
  if (!team) return { ok: false, error: "Team request not found." };
  if (team.status === "rejected") return { ok: false, error: "This request was declined." };
  const m = Math.min(36, Math.max(1, Math.floor(Number(months) || 1)));
  const from = Math.max(Date.now(), Number(team.paidUntil || 0));
  const paidUntil = from + m * 30 * 24 * 60 * 60 * 1000;
  return { ok: true, team: await updateTeam(id, { status: "active", paidUntil }) };
}

/** Operator ends a team at once (refund, abuse). */
export async function endTeam(id) {
  const team = await getTeam(id);
  if (!team) return { ok: false, error: "Team request not found." };
  return { ok: true, team: await updateTeam(id, { status: "ended", paidUntil: 0 }) };
}

// ---- 3. purchase ----

/** Stripe paid for the team (checkout.session.completed with metadata.team_id). */
export async function activateTeamFromCheckout(teamId, subscriptionId) {
  const team = await getTeam(teamId);
  if (!team || team.status === "rejected" || team.status === "ended") return null;
  return updateTeam(teamId, { status: "active", subscriptionId: String(subscriptionId || "") });
}

// ---- 4. members ----

/** The owner lists who else is on the plan (by e-mail; the owner holds one seat). */
export async function setTeamMembers(ownerId, emails) {
  const team = await teamOwnedBy(ownerId);
  if (!team || !["approved", "active"].includes(team.status)) return { ok: false, error: "You have no Team plan yet." };
  const list = [...new Set((Array.isArray(emails) ? emails : String(emails || "").split(/[\s,;]+/)).map(normEmail).filter(Boolean))];
  const bad = list.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) return { ok: false, error: `“${bad}” is not an e-mail address.` };
  const others = list.filter((e) => e !== team.ownerEmail);
  if (others.length > team.seats - 1) {
    return { ok: false, error: `Your plan covers ${team.seats} accounts — yours and ${team.seats - 1} more.` };
  }
  return { ok: true, team: await teamView(await updateTeam(team.id, { members: others })) };
}
