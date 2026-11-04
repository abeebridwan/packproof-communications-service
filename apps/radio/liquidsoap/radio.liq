settings.log.stdout.set(true)
settings.log.level.set(3)
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("0.0.0.0")
settings.server.telnet.port.set(1234)

announcements = request.queue(id="announcements")
bed = single("/data/media/background.wav")
radio = fallback(track_sensitive=false, [announcements, bed])

previous = ref("")
def receipt(kind, playback_id)
  if playback_id != "" then
    body = '{"kind":"#{kind}","playbackId":"#{playback_id}"}'
    response = http.post(
      timeout=3., redirect=false, headers=[("Authorization", "Bearer " ^ environment.get("RADIO_CONTROL_TOKEN")), ("Content-Type", "application/json")],
      data=body,
      "http://radio-worker:8787/internal/playback"
    )
    if response.status_code != 200 then
      log("Playback receipt was not accepted")
    end
  end
end

def track_started(metadata)
  # Track selection is synchronous; network receipts run off the audio clock.
  old = previous()
  current = metadata["pp_playback_id"]
  previous := current
  thread.run(fast=false, fun () -> begin
    receipt("completed", old)
    receipt("started", current)
  end)
end
radio.on_track(track_started)
output.icecast(%mp3(bitrate=96, samplerate=44100, stereo=true),
  host="icecast",port=8000,user="source",
  password=environment.get("ICECAST_SOURCE_PASSWORD"),
  mount="/packproof.mp3",name="PackProof Demo Radio",public=false,radio)
