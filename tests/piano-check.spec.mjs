import { test, expect, openPage } from './support/site.mjs';

/**
 * Replaces Web MIDI with a fake piano before the page loads.
 * Sent messages are kept in window.__sent as { bytes, at }, and window.__pianoSends(bytes) plays a message from the piano.
 * Windows lists its software synth as an output too, so the fake does the same to check the piano is chosen.
 */
async function fakeMidi(page, { deny = false, pianoName = 'Symphony Grand II' } = {}) {
    await page.addInitScript(({ deny, pianoName }) => {
        window.__sent = [];
        const listeners = new Set();
        const synth = { id: 'synth', name: 'Microsoft GS Wavetable Synth', manufacturer: 'Microsoft', send() { } };
        const output = {
            id: 'piano-out', name: pianoName, manufacturer: 'Williams',
            send(bytes, at) { window.__sent.push({ bytes: [...bytes], at: at ?? null }); },
            clear() { window.__cleared = (window.__cleared || 0) + 1; },
        };
        const input = {
            id: 'piano-in', name: pianoName, manufacturer: 'Williams',
            addEventListener(type, fn) { if (type === 'midimessage') listeners.add(fn); },
            removeEventListener(type, fn) { listeners.delete(fn); },
        };
        window.__pianoSends = bytes => listeners.forEach(fn => fn({ data: new Uint8Array(bytes) }));
        navigator.requestMIDIAccess = async options => {
            window.__midiOptions = options;
            if (deny) throw new DOMException('Denied', 'NotAllowedError');
            return {
                outputs: new Map([[synth.id, synth], [output.id, output]]),
                inputs: new Map([[input.id, input]]),
                addEventListener() { },
            };
        };
    }, { deny, pianoName });
}

const tool = page => page.locator('app-piano-check');
const sent = page => page.evaluate(() => window.__sent);

async function connect(page) {
    await tool(page).getByRole('button', { name: 'Connect piano' }).click();
    await expect(tool(page).getByRole('status')).toContainText('Connected.');
}

test.describe('app-piano-check', () => {
    test('without Web MIDI it says so and cannot connect', async ({ page }) => {
        await page.addInitScript(() => { delete Navigator.prototype.requestMIDIAccess; });
        await openPage(page, '/piano-check');
        await expect(tool(page).getByRole('status')).toContainText("can't connect to a piano");
        await expect(tool(page).getByRole('button', { name: 'Connect piano' })).toBeDisabled();
        await expect(tool(page).getByRole('button', { name: 'Play scale' })).toBeDisabled();
    });

    test('says when the browser denies the connection', async ({ page }) => {
        await fakeMidi(page, { deny: true });
        await openPage(page, '/piano-check');
        await tool(page).getByRole('button', { name: 'Connect piano' }).click();
        await expect(tool(page).getByRole('status')).toContainText("didn't allow");
    });

    test('connects without SysEx and picks the piano over the software synth', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        expect(await page.evaluate(() => window.__midiOptions)).toEqual({ sysex: false });
        await expect(tool(page).getByLabel('Send to')).toHaveValue('piano-out');
        await expect(tool(page).getByLabel('Listen to')).toHaveValue('piano-in');
    });

    test('a light test plays middle C on its channel, then releases it', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Play test: Channel 5', exact: true }).click();
        const messages = await sent(page);
        expect(messages[0]).toEqual({ bytes: [0x94, 60, 64], at: null });
        expect(messages[1].bytes).toEqual([0x84, 60, 0]);
        expect(messages[1].at).toBeGreaterThan(0);
    });

    test('a silent light test turns the channel down first and restores it after the note', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Play test: Channel 7 with volume and expression at 0', exact: true }).click();
        const messages = await sent(page);
        expect(messages.map(m => m.bytes)).toEqual([
            [0xB6, 7, 0], [0xB6, 11, 0], [0x96, 60, 64], [0x86, 60, 0], [0xB6, 7, 100], [0xB6, 11, 127],
        ]);
        expect(messages[0].at).toBeNull();
        expect(messages[4].at).toBeGreaterThan(messages[3].at);
        expect(messages[5].at).toBeGreaterThan(messages[3].at);
    });

    test('notes are added to the results', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByLabel("Notes, such as the light's color").fill('Channel 1 was blue');
        await expect(tool(page).getByLabel('Results')).toContainText('Notes: Channel 1 was blue');
    });

    test('results list the played tests with what was ticked', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Play test: Channel 1', exact: true }).click();
        await tool(page).getByRole('button', { name: 'Play test: Channel 2', exact: true }).click();
        await tool(page).getByRole('checkbox', { name: 'Lit: Channel 1', exact: true }).check();
        await tool(page).getByRole('checkbox', { name: 'Sound: Channel 2', exact: true }).check();
        const results = tool(page).getByLabel('Results');
        await expect(results).toContainText('Piano: Symphony Grand II (Williams)');
        await expect(results).toContainText('Channel 1 | yes | no');
        await expect(results).toContainText('Channel 2 | no | yes');
        await expect(results).not.toContainText('Channel 3 |');
    });

    test('the demo picks the grand piano sound and plays a scale on the demo channel', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await expect(tool(page).getByLabel('Demo channel')).toHaveValue('4');
        await tool(page).getByRole('button', { name: 'Play scale' }).click();
        const messages = await sent(page);
        expect(messages[0].bytes).toEqual([0xC3, 0]);
        const noteOns = messages.filter(m => m.bytes[0] === 0x93).map(m => m.bytes[1]);
        expect(noteOns).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]);
        const times = messages.filter(m => m.bytes[0] === 0x93).map(m => m.at);
        expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    test('stop clears scheduled notes and sends All Notes Off on every channel', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Stop all notes' }).click();
        expect(await page.evaluate(() => window.__cleared)).toBe(1);
        const allNotesOff = (await sent(page)).filter(m => (m.bytes[0] & 0xF0) === 0xB0 && m.bytes[1] === 123);
        expect(allNotesOff.map(m => m.bytes[0] & 0x0F)).toEqual([...Array(16).keys()]);
    });

    test('Local Control turned off is turned back on when the tool goes away', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Turn Local Control off' }).click();
        expect((await sent(page)).at(-1).bytes).toEqual([0xB0, 122, 0]);
        await page.evaluate(() => document.querySelector('app-piano-check').remove());
        await expect.poll(async () => (await sent(page)).at(-1).bytes).toEqual([0xB0, 122, 127]);
    });

    test('moving the tool on the page leaves the piano as it is', async ({ page }) => {
        await fakeMidi(page);
        await openPage(page, '/piano-check');
        await connect(page);
        await tool(page).getByRole('button', { name: 'Turn Local Control off' }).click();
        const before = (await sent(page)).length;
        await page.evaluate(async () => {
            const el = document.querySelector('app-piano-check');
            el.parentNode.append(el);
            await new Promise(resolve => setTimeout(resolve, 50));
        });
        expect((await sent(page)).length).toBe(before);
    });

    test('shows what the piano sends, newest first, as text', async ({ page }) => {
        await fakeMidi(page, { pianoName: '<img src=x onerror="window.__attacked=1">' });
        await openPage(page, '/piano-check');
        await connect(page);
        await page.evaluate(() => {
            window.__pianoSends([0x90, 60, 100]);
            window.__pianoSends([0xF8]);
            window.__pianoSends([0x80, 60, 0]);
        });
        const items = tool(page).getByRole('list', { name: 'Messages from the piano' }).getByRole('listitem');
        await expect(items).toHaveText(['Note off C4 (60), channel 1', 'Note on C4 (60), velocity 100, channel 1']);
        await expect(tool(page).getByLabel('Send to')).toContainText('<img src=x');
        await expect(tool(page).locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => window.__attacked)).toBeUndefined();
    });
});
