import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { adminAc, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import type { Role as _AccessRole, ExactRoleStatements as _ExactRoleStatements } from 'better-auth/plugins/access';
import type { AppConfig } from '../core/config.js';
import * as schema from './schema.js';

// Re-exported only so TypeScript can name createAuth's inferred return type in .d.ts output.
export type { _AccessRole, _ExactRoleStatements };

export interface CreateAuthOptions {
  db: Parameters<typeof drizzleAdapter>[0];
  config: AppConfig;
}

export function createAuth({ db, config }: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    baseURL: config.baseUrl,
    secret: config.authSecret,
    trustedOrigins: [config.baseUrl],
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        scope: ['read:user', 'user:email'],
      },
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        scope: ['openid', 'email', 'profile'],
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github'],
      },
    },
    emailAndPassword: {
      enabled: false,
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        secure: true,
      },
    },
    plugins: [
      organization({
        creatorRole: 'owner',
        invitationExpiresIn: 7 * 24 * 60 * 60,
        roles: {
          owner: ownerAc,
          admin: adminAc,
          member: memberAc,
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
