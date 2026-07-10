#!/usr/bin/env python3
"""
Live end-to-end test suite for the Verilog/HDL simulation API.

Hits a running eSim-Cloud stack (nginx on localhost:80 by default) exactly
the way the VerilogSimulator frontend does: POST api/verilog/upload with
sources + testbench JSON, then poll api/verilog/status/<task_id> until the
celery task settles, and assert on compile_log / sim_output / waveform.

Usage:
    python3 test_verilog_live.py [base_url]
    # default base_url: http://localhost/api
"""

import json
import sys
import time
import urllib.request
import urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost/api').rstrip('/')
POLL_TIMEOUT = 90   # seconds per test
POLL_INTERVAL = 1.0

PASS, FAIL = [], []


def _http(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def run_task(sources, testbench, mode='simulate', compiler='iverilog'):
    """Submit and poll one simulation; returns final details dict."""
    body = {'sources': sources, 'testbench': testbench,
            'mode': mode, 'compiler': compiler}
    res = _http('POST', BASE + '/verilog/upload', body)
    task_id = res.get('task_id')
    assert task_id, 'no task_id in upload response: %r' % res
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        st = _http('GET', BASE + '/verilog/status/' + task_id)
        if st['state'] == 'SUCCESS':
            return st.get('details') or {}
        if st['state'] == 'FAILURE':
            raise AssertionError('celery FAILURE: %r' % (st.get('details'),))
        time.sleep(POLL_INTERVAL)
    raise AssertionError('poll timed out after %ss' % POLL_TIMEOUT)


def check(name, fn):
    t0 = time.time()
    try:
        fn()
        PASS.append(name)
        print('PASS  %-42s (%.1fs)' % (name, time.time() - t0))
    except Exception as e:
        FAIL.append((name, str(e)))
        print('FAIL  %-42s %s' % (name, e))


# ── fixtures ──────────────────────────────────────────────────────────

AND_GATE = {'filename': 'and_gate.v', 'content': '''
module and_gate (input wire a, input wire b, output wire y);
    assign y = a & b;
endmodule
'''}

TB_AND = {'filename': 'tb_and_gate.v', 'content': '''
`timescale 1ns/1ps
module tb_and_gate;
    reg a, b; wire y;
    and_gate uut (.a(a), .b(b), .y(y));
    initial begin
        $dumpfile("dump.vcd");
        $dumpvars(0, tb_and_gate);
        a = 0; b = 0; #10;
        a = 0; b = 1; #10;
        a = 1; b = 0; #10;
        a = 1; b = 1; #10;
        $display("RESULT y=%b", y);
        $finish;
    end
endmodule
'''}

TB_NO_DUMP = {'filename': 'tb_nodump.v', 'content': '''
module tb_nodump;
    reg a, b; wire y;
    and_gate uut (.a(a), .b(b), .y(y));
    initial begin
        a = 1; b = 1; #10;
        $display("NODUMP y=%b", y);
        $finish;
    end
endmodule
'''}

BROKEN = {'filename': 'broken.v', 'content': '''
module broken (input wire a output wire y);   // missing comma -> error
    assign y = a
endmodule
'''}

TB_BROKEN = {'filename': 'tb_broken.v', 'content': '''
module tb_broken;
    initial begin #1; $finish; end
endmodule
'''}

SV_COUNTER_TB = {'filename': 'tb_counter.sv', 'content': '''
module counter (input logic clk, input logic rst,
                output logic [3:0] count);
    always_ff @(posedge clk)
        if (rst) count <= '0;
        else     count <= count + 1;
endmodule

module tb_counter;
    logic clk = 0, rst = 1;
    logic [3:0] count;
    counter uut (.clk(clk), .rst(rst), .count(count));
    always #5 clk = ~clk;
    initial begin
        $dumpfile("dump.vcd");
        $dumpvars(0, tb_counter);
        #12 rst = 0;
        #100 $display("SV count=%0d", count);
        $finish;
    end
endmodule
'''}

VHDL_TB = {'filename': 'tb_and.vhd', 'content': '''
library ieee;
use ieee.std_logic_1164.all;

entity tb_and is end entity;

architecture sim of tb_and is
  signal a, b, y : std_logic := '0';
begin
  y <= a and b;
  process begin
    a <= '1'; b <= '1';
    wait for 10 ns;
    assert y = '1' report "AND failed" severity note;
    wait;
  end process;
end architecture;
'''}


# ── tests ─────────────────────────────────────────────────────────────

def test_simulate_and_gate():
    d = run_task([AND_GATE], TB_AND)
    assert d.get('success'), 'success flag false: %s' % d.get('compile_log')
    assert 'RESULT y=1' in d.get('sim_output', ''), \
        'expected RESULT y=1 in sim_output, got: %r' % d.get('sim_output')


def test_waveform_produced():
    d = run_task([AND_GATE], TB_AND)
    wf = d.get('waveform') or {}
    assert wf.get('graph') == 'true', 'waveform.graph != true: %r' % wf
    assert wf.get('data'), 'waveform.data empty'
    assert d.get('vcd_raw', '').startswith('$'), 'vcd_raw missing/invalid'


def test_syntax_check_ok():
    d = run_task([AND_GATE], TB_AND, mode='syntax_check')
    assert d.get('success'), d.get('compile_log')
    assert '[OK]' in d.get('compile_log', '')


def test_syntax_check_catches_error():
    d = run_task([BROKEN], TB_BROKEN, mode='syntax_check')
    assert not d.get('success'), 'broken source passed syntax check!'
    assert 'error' in d.get('compile_log', '').lower()


def test_simulate_error_reported():
    d = run_task([BROKEN], TB_BROKEN)
    assert not d.get('success'), 'broken source simulated successfully!'


def test_dumpvars_injected():
    # testbench without $dumpfile/$dumpvars must still yield a waveform
    d = run_task([AND_GATE], TB_NO_DUMP)
    assert d.get('success'), d.get('compile_log')
    assert 'NODUMP y=1' in d.get('sim_output', '')
    wf = d.get('waveform') or {}
    assert wf.get('graph') == 'true', \
        'auto-injected dumpvars produced no waveform: %r' % wf.get('error')


def test_systemverilog():
    d = run_task([], SV_COUNTER_TB, compiler='systemverilog')
    assert d.get('success'), d.get('compile_log')
    assert 'SV count=' in d.get('sim_output', '')


def test_multifile():
    top = {'filename': 'top.v', 'content': '''
module top (input wire a, input wire b, output wire y);
    and_gate g (.a(a), .b(b), .y(y));
endmodule
'''}
    tb = {'filename': 'tb_top.v', 'content': '''
module tb_top;
    reg a, b; wire y;
    top uut (.a(a), .b(b), .y(y));
    initial begin
        $dumpfile("dump.vcd"); $dumpvars(0, tb_top);
        a = 1; b = 1; #10;
        $display("MULTI y=%b", y);
        $finish;
    end
endmodule
'''}
    d = run_task([AND_GATE, top], tb)
    assert d.get('success'), d.get('compile_log')
    assert 'MULTI y=1' in d.get('sim_output', '')


def test_vhdl_nvc():
    # NVC is a best-effort install; accept either success or a clean
    # "not found" style failure, but never a crash/hang.
    try:
        d = run_task([], VHDL_TB, compiler='vhdl')
    except AssertionError as e:
        raise AssertionError('vhdl task crashed: %s' % e)
    if d.get('success'):
        return
    log = d.get('compile_log', '')
    assert log, 'vhdl failed with empty compile_log'
    print('      (VHDL/NVC unavailable — clean failure reported)')


if __name__ == '__main__':
    print('Target: %s\n' % BASE)
    check('simulate: AND gate output correct', test_simulate_and_gate)
    check('simulate: waveform + raw VCD returned', test_waveform_produced)
    check('syntax_check: valid code passes', test_syntax_check_ok)
    check('syntax_check: bad code rejected', test_syntax_check_catches_error)
    check('simulate: bad code reported failed', test_simulate_error_reported)
    check('simulate: $dumpvars auto-injection', test_dumpvars_injected)
    check('simulate: SystemVerilog (-g2012)', test_systemverilog)
    check('simulate: multi-file project', test_multifile)
    check('simulate: VHDL via NVC (best-effort)', test_vhdl_nvc)
    print('\n%d passed, %d failed' % (len(PASS), len(FAIL)))
    sys.exit(1 if FAIL else 0)
