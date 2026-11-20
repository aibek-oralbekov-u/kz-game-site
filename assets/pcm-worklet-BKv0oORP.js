// Only transient PCM is transferred to the local recognizer; no recording or storage.
class VoicePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.stopped = true;
      this.flush();
      this.port.postMessage('flushed');
    };
  }
  flush() {
    if (!this.length) return;
    const chunk = this.samples.slice(0, this.length);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.length = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.samples[this.length++] = sample;
        if (this.length === this.samples.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePcm);
