import { createClient } from 'npm:@supabase/supabase-js@2.54.0';
import { createAdminResetPasswordHandler } from './handler.ts';

const handler = createAdminResetPasswordHandler({
  createClient,
  getEnv: (name) => Deno.env.get(name),
});

Deno.serve(handler);
