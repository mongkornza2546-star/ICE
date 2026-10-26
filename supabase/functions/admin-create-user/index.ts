import { createClient } from 'npm:@supabase/supabase-js@2.54.0';
import { createAdminCreateUserHandler } from './handler.ts';

Deno.serve(createAdminCreateUserHandler({
  createClient,
  getEnv: (name) => Deno.env.get(name),
}));
