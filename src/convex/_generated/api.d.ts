/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as attendance from "../attendance.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as auth_password from "../auth/password.js";
import type * as callState from "../callState.js";
import type * as calls from "../calls.js";
import type * as chats from "../chats.js";
import type * as classes from "../classes.js";
import type * as codes from "../codes.js";
import type * as crons from "../crons.js";
import type * as drive from "../drive.js";
import type * as fees from "../fees.js";
import type * as gifs from "../gifs.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as names from "../names.js";
import type * as passwords from "../passwords.js";
import type * as practice from "../practice.js";
import type * as push from "../push.js";
import type * as pushSend from "../pushSend.js";
import type * as studios from "../studios.js";
import type * as tour from "../tour.js";
import type * as usernames from "../usernames.js";
import type * as users from "../users.js";
import type * as vault from "../vault.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  attendance: typeof attendance;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  "auth/password": typeof auth_password;
  callState: typeof callState;
  calls: typeof calls;
  chats: typeof chats;
  classes: typeof classes;
  codes: typeof codes;
  crons: typeof crons;
  drive: typeof drive;
  fees: typeof fees;
  gifs: typeof gifs;
  http: typeof http;
  migrations: typeof migrations;
  names: typeof names;
  passwords: typeof passwords;
  practice: typeof practice;
  push: typeof push;
  pushSend: typeof pushSend;
  studios: typeof studios;
  tour: typeof tour;
  usernames: typeof usernames;
  users: typeof users;
  vault: typeof vault;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
