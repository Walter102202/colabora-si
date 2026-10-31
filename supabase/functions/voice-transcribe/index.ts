// POST /functions/v1/voice-transcribe: one WAV from a signed-in person or the platform agent (verify_jwt = true).
import { oauthError } from '../_shared/errors.ts';
import { callerClient, denoEnv, MisconfiguredError, serviceClient } from '../_shared/supabase.ts';
import { listSetting, transcribeWav } from '../_shared/voice/meta.ts';
import { CORS_HEADERS, handleVoiceTranscribe } from './handler.ts';

Deno.serve(async (req) => {
  const env = denoEnv();
  try {
    return await handleVoiceTranscribe(req, {
      async reserve(token, a) {
        const { data, error } = await callerClient(env, token).rpc('voice_reserve', {
          p_workspace_id: a.workspace_id, p_duration_ms: a.duration_ms, p_bytes: a.bytes, p_channel: a.channel, p_chat_id: a.chat_id,
          p_forwarded: a.forwarded, p_lang: a.lang, p_message_id: a.message_id,
        });
        if (error) throw error;
        return data as { clip_id?: string; duplicate?: boolean };
      },
      async complete(clipId, audioMs) {
        const { error } = await serviceClient(env).rpc('voice_complete', { p_clip_id: clipId, p_audio_ms: audioMs });
        if (error) throw error;
      },
      async fail(clipId, code) {
        await serviceClient(env).rpc('voice_fail', { p_clip_id: clipId, p_code: code });
      },
      transcribe(wav, signal) {
        if (!env.META_MODEL_API_KEY) throw new MisconfiguredError('META_MODEL_API_KEY');
        return transcribeWav(wav, signal, {
          apiKey: env.META_MODEL_API_KEY, baseUrl: env.META_API_BASE,
          languageBias: listSetting(env.VOICE_LANGUAGE_BIAS), keywords: listSetting(env.VOICE_KEYWORDS),
        });
      },
    });
  } catch (err) {
    if (err instanceof MisconfiguredError) return oauthError(500, 'misconfigured', 'Voice is not configured.', CORS_HEADERS);
    return oauthError(500, 'voice_failed', 'The transcription failed.', CORS_HEADERS);
  }
});
