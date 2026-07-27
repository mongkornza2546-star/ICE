import { createClient } from 'npm:@supabase/supabase-js@2.54.0';
import { createNicknamePasswordSignInHandler } from './handler.ts';

const handler = createNicknamePasswordSignInHandler({
  createClient,
  getEnv: (name) => Deno.env.get(name),
});

Deno.serve(handler);
