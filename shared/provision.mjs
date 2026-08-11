/**
 * provision.mjs — per-space manifest naming and DID restore snapshots.
 *
 * The demo space keeps the original unscoped filenames (topology.json,
 * webphone.json, …) so nothing recorded so far moves; every other space gets
 * its own set (topology.acme.json) and can be set up / torn down without
 * touching another space's manifests.
 */

import path from 'node:path';

export function spaceSlug(spaceUrl) {
  return String(spaceUrl || 'demo.signalwire.com').split('.')[0].replace(/[^a-z0-9-]/gi, '') || 'space';
}

export function scopedPath(dir, baseName, spaceUrl) {
  const slug = spaceSlug(spaceUrl);
  if (slug === 'demo') return path.join(dir, baseName);
  const ext = path.extname(baseName);
  return path.join(dir, `${baseName.slice(0, -ext.length)}.${slug}${ext}`);
}

// The call-routing surface of a phone number: everything setup may overwrite
// when adopting a user's DID, captured so teardown can put it back verbatim.
export const NUMBER_ROUTING_FIELDS = [
  'name',
  'call_handler',
  'call_receive_mode',
  'call_request_url',
  'call_request_method',
  'call_fallback_url',
  'call_fallback_method',
  'call_status_callback_url',
  'call_status_callback_method',
  'call_laml_application_id',
  'call_dialogflow_agent_id',
  'call_relay_topic',
  'call_relay_topic_status_callback_url',
  'call_relay_context',
  'call_relay_context_status_callback_url',
  'call_relay_application',
  'call_relay_script_url',
  'call_flow_id',
  'call_video_room_id',
];

export function snapshotNumberRouting(number) {
  const prior = {};
  for (const f of NUMBER_ROUTING_FIELDS) {
    if (number[f] !== undefined) prior[f] = number[f];
  }
  return prior;
}
