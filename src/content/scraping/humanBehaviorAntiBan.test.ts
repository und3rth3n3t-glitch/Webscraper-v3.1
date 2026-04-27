import { describe, it, expect } from 'vitest';
import { keyboardEventInit } from './humanBehavior';

describe('keyboardEventInit', () => {
  it('maps lowercase letters to KeyX with uppercase keyCode', () => {
    const init = keyboardEventInit('a');
    expect(init.key).toBe('a');
    expect(init.code).toBe('KeyA');
    expect(init.keyCode).toBe(65);
    expect(init.which).toBe(65);
  });

  it('maps uppercase letters consistently', () => {
    expect(keyboardEventInit('Z').code).toBe('KeyZ');
    expect(keyboardEventInit('Z').keyCode).toBe(90);
  });

  it('maps digits to DigitN', () => {
    expect(keyboardEventInit('0').code).toBe('Digit0');
    expect(keyboardEventInit('9').code).toBe('Digit9');
    expect(keyboardEventInit('5').keyCode).toBe(53);
  });

  it('maps space to Space/32', () => {
    expect(keyboardEventInit(' ').code).toBe('Space');
    expect(keyboardEventInit(' ').keyCode).toBe(32);
  });

  it('leaves code undefined for symbols but still sets keyCode', () => {
    const init = keyboardEventInit('-');
    expect(init.code).toBeUndefined();
    expect(init.keyCode).toBe('-'.charCodeAt(0));
  });

  it('always sets bubbles and cancelable', () => {
    const init = keyboardEventInit('x');
    expect(init.bubbles).toBe(true);
    expect(init.cancelable).toBe(true);
  });
});
