/*!
 * Guided Piano Piano Check
 * Connects to a digital piano over Web MIDI to test which messages light its keys, play demo notes through
 * its own sound, and show what it sends back.
 * Authored by Erik Gassler - Stoic Dreams
 * Copyright © 2026 Stoic Dreams - https://www.stoicdreams.com
 * Licensed under the MIT license - https://github.com/StoicDreams/GuidedPiano/blob/main/Docs/LICENSE
 */
"use strict"
{
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    /** Middle C is MIDI note 60, written C4. */
    const noteName = note => `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
    const TEST_NOTE = 60;
    const TEST_HOLD_MS = 2000;
    // The piano's own keyboard sends on channels 1 to 3, so demos default to the first channel after them.
    const DEMO_CHANNEL = 4;
    const SCALE = [60, 62, 64, 65, 67, 69, 71, 72];
    const LOG_LIMIT = 40;

    /** Each test plays middle C once. Channels are 1-16 as pianos show them; MIDI bytes use 0-15. */
    const TESTS = [];
    for (let channel = 1; channel <= 16; channel++) {
        TESTS.push({ channel, velocity: 64, label: `Channel ${channel}${channel === 10 ? ' (drums in General MIDI)' : ''}` });
    }
    TESTS.push({ channel: 1, velocity: 1, label: 'Channel 1, softest note (velocity 1)' });
    TESTS.push({ channel: 1, velocity: 127, label: 'Channel 1, loudest note (velocity 127)' });

    /** Describes a MIDI message in words, or returns null for timing messages that would flood the log. */
    function describe(data) {
        const [status, a, b] = data;
        if (status >= 0xF8) return null;
        const type = status & 0xF0;
        const channel = (status & 0x0F) + 1;
        switch (type) {
            case 0x90:
                if (b > 0) return `Note on ${noteName(a)} (${a}), velocity ${b}, channel ${channel}`;
                return `Note off ${noteName(a)} (${a}), channel ${channel}`;
            case 0x80:
                return `Note off ${noteName(a)} (${a}), channel ${channel}`;
            case 0xB0:
                return `Control change ${a} = ${b}, channel ${channel}`;
            case 0xC0:
                return `Program change ${a + 1}, channel ${channel}`;
            case 0xE0:
                return `Pitch bend ${(b << 7) | a}, channel ${channel}`;
        }
        if (status === 0xF0) return `System exclusive, ${data.length} bytes`;
        return `Message ${[...data].map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`;
    }

    /** Builds an option with its text set as text, since port names come from the device. */
    function option(value, text) {
        const el = document.createElement('option');
        el.value = value;
        el.textContent = text;
        return el;
    }

    webui.define('app-piano-check', {
        constructor() {
            const t = this;
            const q = selector => t.template.querySelector(selector);
            t._status = q('.status');
            t._connect = q('.connect');
            t._output = q('select.output');
            t._input = q('select.input');
            t._tests = q('tbody');
            t._results = q('.results');
            t._copy = q('.copy');
            t._demoChannel = q('select.demo-channel');
            t._playScale = q('.play-scale');
            t._stop = q('.stop');
            t._localOff = q('.local-off');
            t._localOn = q('.local-on');
            t._log = q('.log');
            t._clearLog = q('.clear-log');
            t._access = null;
            t._localTurnedOff = false;

            for (let channel = 1; channel <= 16; channel++) {
                t._demoChannel.append(option(channel, `Channel ${channel}`));
            }
            t._demoChannel.value = `${DEMO_CHANNEL}`;

            t._rows = TESTS.map((test, index) => {
                const row = document.createElement('tr');
                const name = document.createElement('th');
                name.scope = 'row';
                name.textContent = test.label;
                const playCell = document.createElement('td');
                const play = document.createElement('button');
                play.type = 'button';
                play.className = 'needs-output';
                play.textContent = 'Play';
                play.setAttribute('aria-label', `Play test: ${test.label}`);
                play.addEventListener('click', () => t.playTest(index));
                playCell.append(play);
                const checks = ['Lit', 'Sound'].map(what => {
                    const cell = document.createElement('td');
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    box.setAttribute('aria-label', `${what}: ${test.label}`);
                    box.addEventListener('change', () => t.updateResults());
                    cell.append(box);
                    return { cell, box };
                });
                row.append(name, playCell, checks[0].cell, checks[1].cell);
                t._tests.append(row);
                return { test, play, lit: checks[0].box, sound: checks[1].box, played: false };
            });

            // The template's nodes move into the shadow root after this, so these references stay valid.
            t._needsOutput = [...t.template.querySelectorAll('.needs-output')];
            t._connect.addEventListener('click', () => t.connectPiano());
            t._output.addEventListener('change', () => t.updateResults());
            t._input.addEventListener('change', () => t.listen());
            t._copy.addEventListener('click', () => t.copyResults());
            t._playScale.addEventListener('click', () => t.playScale());
            t._stop.addEventListener('click', () => t.stopAll());
            t._localOff.addEventListener('click', () => t.setLocal(false));
            t._localOn.addEventListener('click', () => t.setLocal(true));
            t._clearLog.addEventListener('click', () => t._log.replaceChildren());
            t._onMessage = event => t.logMessage(event.data);
            t._onPageHide = () => t.release();
        },
        connected() {
            const t = this;
            window.addEventListener('pagehide', t._onPageHide);
            if (typeof navigator.requestMIDIAccess !== 'function') {
                t.setStatus("This browser can't connect to a piano. Chrome, Edge, and Firefox can. Safari can't.");
                t._connect.disabled = true;
            }
            t.updateControls();
            t.updateResults();
        },
        reconnected() {
            window.addEventListener('pagehide', this._onPageHide);
        },
        disconnected() {
            const t = this;
            // webui-content moves its children when they scroll out of view, which disconnects and reconnects them
            // at once. Only release the piano when the tool is really gone.
            queueMicrotask(() => {
                if (t.isConnected) return;
                window.removeEventListener('pagehide', t._onPageHide);
                t.release();
            });
        },
        setStatus(message) {
            this._status.textContent = message;
        },
        async connectPiano() {
            const t = this;
            if (t._access) {
                t.refreshPorts();
                return;
            }
            t.setStatus('Asking to connect…');
            try {
                t._access = await navigator.requestMIDIAccess({ sysex: false });
            } catch (error) {
                t.setStatus(`The browser didn't allow the connection (${error?.name || 'error'}). Allow MIDI devices for this site, then try again.`);
                return;
            }
            t._access.addEventListener('statechange', () => t.refreshPorts());
            t.refreshPorts();
        },
        /** Lists the ports, keeping the current choice when it is still there. */
        refreshPorts() {
            const t = this;
            const outputs = [...t._access.outputs.values()];
            const inputs = [...t._access.inputs.values()];
            const keep = (select, ports) => {
                const current = select.value;
                select.replaceChildren(...ports.map(port => option(port.id, port.name || port.manufacturer || 'Unnamed device')));
                if (ports.some(port => port.id === current)) select.value = current;
                return !!current && select.value === current;
            };
            const keptOutput = keep(t._output, outputs);
            const keptInput = keep(t._input, inputs);
            // Prefer an output that shares a name with an input, which is the piano rather than a software synth.
            if (!keptOutput) {
                const inputNames = new Set(inputs.map(port => port.name));
                const piano = outputs.find(port => inputNames.has(port.name));
                if (piano) t._output.value = piano.id;
            }
            if (!keptInput && inputs.length) t._input.value = inputs[0].id;
            if (!outputs.length && !inputs.length) {
                t.setStatus('Connected to the browser, but no piano was found. Plug in the piano or pair it with Bluetooth MIDI, and turn it on.');
            } else if (!outputs.length) {
                t.setStatus('The piano sends notes, but nothing was found to send notes to.');
            } else {
                t.setStatus(`Connected. ${outputs.length} output${outputs.length === 1 ? '' : 's'} and ${inputs.length} input${inputs.length === 1 ? '' : 's'} found.`);
            }
            t.listen();
            t.updateControls();
            t.updateResults();
        },
        output() {
            return this._access?.outputs.get(this._output.value) || null;
        },
        listen() {
            const t = this;
            if (!t._access) return;
            t._access.inputs.forEach(port => port.removeEventListener('midimessage', t._onMessage));
            const input = t._access.inputs.get(t._input.value);
            input?.addEventListener('midimessage', t._onMessage);
        },
        updateControls() {
            const t = this;
            const disabled = !t.output();
            t._needsOutput.forEach(el => el.disabled = disabled);
        },
        send(bytes, at) {
            const output = this.output();
            if (!output) return false;
            output.send(bytes, at);
            return true;
        },
        playTest(index) {
            const t = this;
            const row = t._rows[index];
            const { channel, velocity } = row.test;
            const status = channel - 1;
            if (!t.send([0x90 | status, TEST_NOTE, velocity])) return;
            t.send([0x80 | status, TEST_NOTE, 0], performance.now() + TEST_HOLD_MS);
            row.played = true;
            t.setStatus(`Played middle C on channel ${channel} for ${TEST_HOLD_MS / 1000} seconds. Tick Lit or Sound for what the piano did.`);
            t.updateResults();
        },
        playScale() {
            const t = this;
            const status = Number(t._demoChannel.value) - 1;
            // Acoustic Grand Piano is the first General MIDI program.
            if (!t.send([0xC0 | status, 0])) return;
            const start = performance.now() + 100;
            const notes = [...SCALE, ...SCALE.slice(0, -1).reverse()];
            notes.forEach((note, i) => {
                t.send([0x90 | status, note, 80], start + i * 400);
                t.send([0x80 | status, note, 0], start + i * 400 + 350);
            });
            t.setStatus(`Playing a C major scale on channel ${status + 1}.`);
        },
        /** Silences everything on every channel, including notes scheduled for later. */
        stopAll() {
            const t = this;
            const output = t.output();
            if (!output) return;
            if (typeof output.clear === 'function') output.clear();
            for (let status = 0; status < 16; status++) {
                output.send([0xB0 | status, 123, 0]);
                output.send([0xB0 | status, 120, 0]);
            }
            t.setStatus('Sent All Notes Off on every channel.');
        },
        setLocal(on) {
            const t = this;
            // Local Control is controller 122. Pianos read it on the channel their keyboard uses, which is usually 1.
            if (!t.send([0xB0, 122, on ? 127 : 0])) return;
            t._localTurnedOff = !on;
            t.setStatus(on
                ? 'Local Control is on. The piano plays its own keys again.'
                : 'Local Control is off. The piano stays silent when you play, until you turn it back on or leave this page.');
        },
        /** Leaves the piano as it was found: no stuck notes and its keyboard connected to its sound. */
        release() {
            const t = this;
            if (!t.output()) return;
            t.stopAll();
            if (t._localTurnedOff) t.setLocal(true);
        },
        logMessage(data) {
            const t = this;
            const text = describe(data);
            if (!text) return;
            const item = document.createElement('li');
            item.textContent = text;
            t._log.prepend(item);
            while (t._log.childElementCount > LOG_LIMIT) t._log.lastElementChild.remove();
        },
        resultsText() {
            const t = this;
            const output = t.output();
            const lines = [
                `Piano: ${output ? `${output.name || 'Unnamed'}${output.manufacturer ? ` (${output.manufacturer})` : ''}` : 'not connected'}`,
                `Browser: ${navigator.userAgent}`,
                '',
                'Test | Lit | Sound',
            ];
            t._rows.filter(row => row.played).forEach(row => {
                lines.push(`${row.test.label} | ${row.lit.checked ? 'yes' : 'no'} | ${row.sound.checked ? 'yes' : 'no'}`);
            });
            if (!t._rows.some(row => row.played)) lines.push('(No tests played yet)');
            return lines.join('\n');
        },
        updateResults() {
            this._results.textContent = this.resultsText();
        },
        async copyResults() {
            const t = this;
            try {
                await navigator.clipboard.writeText(t.resultsText());
                t.setStatus('Copied the results.');
            } catch {
                t.setStatus("Couldn't copy. Select the results text and copy it instead.");
            }
        },
        shadowTemplate: `
<section>
<h2>1. Connect</h2>
<p>Connect your piano to this device with a USB cable, or pair it with Bluetooth MIDI, then press Connect piano. Turn the piano's key lights on.</p>
<div class="row">
<button type="button" class="connect">Connect piano</button>
</div>
<p class="status" role="status" aria-live="polite">Not connected.</p>
<div class="row">
<label>Send to <select class="output"></select></label>
<label>Listen to <select class="input"></select></label>
</div>
</section>
<section>
<h2>2. Key lights and sound</h2>
<p>Each test plays middle C for two seconds. Press Play, watch the light above middle C, then tick Lit if its light came on and Sound if the piano played a note.</p>
<div class="table">
<table>
<thead><tr><th scope="col">Test</th><th scope="col">Play</th><th scope="col">Lit</th><th scope="col">Sound</th></tr></thead>
<tbody></tbody>
</table>
</div>
<div class="row">
<button type="button" class="copy needs-output">Copy results</button>
</div>
<pre class="results" tabindex="0" aria-label="Results"></pre>
</section>
<section>
<h2>3. Demo through the piano</h2>
<p>Plays a scale with the piano's own grand piano sound. The piano's keyboard sends on channels 1 to 3, so a channel above them keeps demo notes apart from what you play.</p>
<div class="row">
<label>Demo channel <select class="demo-channel"></select></label>
<button type="button" class="play-scale needs-output">Play scale</button>
<button type="button" class="stop needs-output">Stop all notes</button>
</div>
</section>
<section>
<h2>4. Local Control</h2>
<p>With Local Control off, the piano's keys stop playing its own sound, and only notes it receives make sound. Try the light tests again with it off. It turns back on when you leave this page.</p>
<div class="row">
<button type="button" class="local-off needs-output">Turn Local Control off</button>
<button type="button" class="local-on needs-output">Turn Local Control on</button>
</div>
</section>
<section>
<h2>5. What the piano sends</h2>
<p>Play some keys. The newest message is at the top. Notes from the demo or the tests show here too if the piano echoes them back.</p>
<div class="row">
<button type="button" class="clear-log">Clear</button>
</div>
<ol class="log" aria-label="Messages from the piano"></ol>
</section>
<style type="text/css">
:host {
display: flex;
flex-direction: column;
gap: calc(2 * var(--padding, 0.5rem));
}
section {
display: flex;
flex-direction: column;
gap: var(--padding, 0.5rem);
}
h2, p {
margin: 0;
}
h2 {
font-size: 1.25em;
}
.row {
display: flex;
flex-wrap: wrap;
align-items: center;
gap: var(--padding, 0.5rem);
}
label {
display: inline-flex;
flex-wrap: wrap;
align-items: center;
gap: 0.5em;
}
button, select {
font: inherit;
border-radius: var(--corners, 6px);
padding: 0.35em 0.9em;
}
button {
border: none;
background-color: var(--color-button, #0b78ce);
color: var(--color-button-offset, #fff);
cursor: pointer;
}
button:disabled {
opacity: 0.5;
cursor: not-allowed;
}
select {
max-width: 100%;
border: 1px solid currentColor;
background-color: var(--color-background, #333);
color: var(--color-background-offset, #fff);
}
button:focus-visible, select:focus-visible, input:focus-visible, pre:focus-visible {
outline: 2px solid var(--color-active, #0b78ce);
outline-offset: 2px;
}
.table {
overflow-x: auto;
}
table {
border-collapse: collapse;
}
th, td {
padding: 0.25em 0.75em;
border-bottom: 1px solid color-mix(in srgb, currentColor 25%, transparent);
text-align: left;
}
td {
text-align: center;
}
input[type="checkbox"] {
width: 1.25em;
height: 1.25em;
}
pre {
margin: 0;
padding: var(--padding, 0.5rem);
white-space: pre-wrap;
overflow-wrap: anywhere;
border-radius: var(--corners, 6px);
background-color: color-mix(in srgb, currentColor 10%, transparent);
}
.log {
margin: 0;
max-height: 20em;
overflow-y: auto;
font-family: monospace;
}
</style>
`
    });
}
