/**
 * HDL Simulator page — Icarus Verilog / GHDL logic simulation with the
 * Logic Analyzer waveform viewer.
 *
 * Flow: source code -> POST simulation/hdl/upload -> poll
 * simulation/status/<task_id> -> parsed VCD payload -> <LogicAnalyzer/>.
 * A local .vcd file can also be opened directly (client-side parser),
 * no backend needed.
 */

import React, { useState, useEffect, useRef } from 'react'
import {
  Container, Grid, Button, Paper, Typography, Select, MenuItem,
  TextField, Dialog, CircularProgress
} from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import AceEditor from 'react-ace'
import 'brace/mode/verilog'
import 'brace/mode/vhdl'
import 'brace/theme/monokai'

import api from '../utils/Api'
import ErrorExplainerCard from '../components/Simulator/ErrorExplainerCard'
import LogicAnalyzer from '../components/LogicAnalyzer/LogicAnalyzer'
import { parseVCD } from '../components/LogicAnalyzer/vcdUtils'

const VERILOG_SAMPLE = `// 4-bit counter + testbench (Icarus Verilog)
module counter (input clk, input rst, output reg [3:0] count);
  always @(posedge clk) begin
    if (rst) count <= 4'b0000;
    else     count <= count + 1;
  end
endmodule

module tb_counter;
  reg clk = 0;
  reg rst = 1;
  wire [3:0] count;

  counter uut (.clk(clk), .rst(rst), .count(count));

  always #5 clk = ~clk;

  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, tb_counter);
    #12 rst = 0;
    #200 $finish;
  end
endmodule
`

const VHDL_SAMPLE = `-- 4-bit counter + testbench (GHDL)
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
  port (clk, rst : in std_logic;
        count    : out std_logic_vector(3 downto 0));
end entity;

architecture rtl of counter is
  signal c : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then
      if rst = '1' then c <= (others => '0');
      else c <= c + 1; end if;
    end if;
  end process;
  count <= std_logic_vector(c);
end architecture;

library ieee;
use ieee.std_logic_1164.all;

-- the LAST entity in the file is elaborated as the testbench
entity tb_counter is end entity;

architecture sim of tb_counter is
  signal clk   : std_logic := '0';
  signal rst   : std_logic := '1';
  signal count : std_logic_vector(3 downto 0);
begin
  uut: entity work.counter port map (clk => clk, rst => rst, count => count);
  clk <= not clk after 5 ns;
  rst <= '0' after 12 ns;
end architecture;
`

const useStyles = makeStyles((theme) => ({
  header: { padding: theme.spacing(4, 0, 6) },
  paper: {
    padding: theme.spacing(2),
    backgroundColor: '#1E1E1E',
    color: '#C9D1D9'
  },
  titlePaper: {
    padding: theme.spacing(2),
    textAlign: 'center',
    backgroundColor: '#141416',
    color: '#C9D1D9'
  },
  controlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: theme.spacing(2)
  },
  select: { color: '#C9D1D9', minWidth: 200 },
  stopTime: { width: 140 },
  status: { marginLeft: 12, display: 'inline-flex', alignItems: 'center' }
}))

export default function HDLSimulator () {
  const classes = useStyles()
  const [simulator, setSimulator] = useState('iverilog')
  const [code, setCode] = useState(VERILOG_SAMPLE)
  const [stopTime, setStopTime] = useState('1000ns')
  const [running, setRunning] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [errorHelp, setErrorHelp] = useState(null)
  const [rawError, setRawError] = useState('')
  const [waveData, setWaveData] = useState(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const codeTouched = useRef(false)
  const pollTimer = useRef(null)

  useEffect(() => {
    document.title = 'HDL Simulator - eSim'
    return () => clearTimeout(pollTimer.current)
  }, [])

  const handleSimulatorChange = (e) => {
    const sim = e.target.value
    setSimulator(sim)
    if (!codeTouched.current) {
      setCode(sim === 'iverilog' ? VERILOG_SAMPLE : VHDL_SAMPLE)
    }
  }

  const onCodeChange = (c) => {
    codeTouched.current = true
    setCode(c)
  }

  const openResult = (details) => {
    setWaveData({
      signals: details.signals || [],
      endtime: details.endtime || 1,
      timescale: details.timescale || '1ns',
      truncated: details.truncated
    })
    setViewerOpen(true)
  }

  const pollStatus = (taskId) => {
    api.get('simulation/status/' + taskId)
      .then((res) => {
        const state = res.data.state
        if (state === 'PROGRESS' || state === 'PENDING') {
          const detail = res.data.details
          setStatusText((detail && detail.current_process) || 'Running…')
          pollTimer.current = setTimeout(() => pollStatus(taskId), 1000)
          return
        }
        setRunning(false)
        const details = res.data.details || {}
        if (details.fail) {
          setRawError(String(details.fail))
          setErrorHelp(details.error_help || null)
          setStatusText('Simulation failed')
        } else if (details.signals) {
          setStatusText('Done — ' + details.signals.length + ' signals')
          openResult(details)
        } else {
          setRawError('Simulation returned no data.')
          setStatusText('Simulation failed')
        }
      })
      .catch(() => {
        setRunning(false)
        setRawError('Could not reach the simulation server.')
        setStatusText('Network error')
      })
  }

  const handleSimulate = () => {
    setErrorHelp(null)
    setRawError('')
    setRunning(true)
    setStatusText('Uploading…')
    const ext = simulator === 'iverilog' ? '.v' : '.vhdl'
    const file = new File([code], 'design' + ext, { type: 'text/plain' })
    const formData = new FormData()
    formData.append('file', file)
    formData.append('simulator', simulator)
    if (simulator === 'ghdl' && stopTime) {
      formData.append('stop_time', stopTime)
    }
    const config = { headers: { 'content-type': 'multipart/form-data' } }
    const token = localStorage.getItem('esim_auth_token')
    if (token) config.headers.Authorization = `Token ${token}`
    api.post('simulation/hdl/upload', formData, config)
      .then((res) => {
        pollStatus(res.data.details.task_id)
      })
      .catch((err) => {
        setRunning(false)
        const data = err.response && err.response.data
        setRawError((data && (data.error || JSON.stringify(data))) ||
          'Upload failed.')
        setStatusText('Upload failed')
      })
  }

  const handleOpenVCDFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseVCD(String(reader.result))
        if (!parsed.signals.length) {
          setRawError('No signals found in the VCD file.')
          return
        }
        setErrorHelp(null)
        setRawError('')
        openResult(parsed)
      } catch (ex) {
        setRawError('Could not parse the VCD file: ' + ex.message)
      }
    }
    reader.readAsText(f)
    e.target.value = ''
  }

  return (
    <Container component="main" maxWidth="lg" className={classes.header}>
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <Paper className={classes.titlePaper}>
            <Typography variant="h4" gutterBottom>
              HDL SIMULATOR
            </Typography>
            <Typography variant="subtitle1">
              eSim on Cloud — Icarus Verilog / GHDL Logic Analyzer
            </Typography>
          </Paper>
        </Grid>

        {errorHelp && (
          <Grid item xs={12}>
            <ErrorExplainerCard
              summary={errorHelp.summary}
              hints={errorHelp.hints}
              codes={errorHelp.codes}
            />
          </Grid>
        )}
        {rawError && !errorHelp && (
          <Grid item xs={12}>
            <Paper className={classes.paper} style={{ color: '#F85149' }}>
              <Typography variant="body2" component="pre"
                style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                {rawError}
              </Typography>
            </Paper>
          </Grid>
        )}

        <Grid item xs={12}>
          <Paper className={classes.paper}>
            <div className={classes.controlRow}>
              <Select
                value={simulator}
                onChange={handleSimulatorChange}
                className={classes.select}
              >
                <MenuItem value="iverilog">Icarus Verilog</MenuItem>
                <MenuItem value="ghdl">GHDL (VHDL)</MenuItem>
              </Select>
              {simulator === 'ghdl' && (
                <TextField
                  label="Stop time"
                  value={stopTime}
                  onChange={(e) => setStopTime(e.target.value)}
                  className={classes.stopTime}
                  helperText="e.g. 1000ns"
                />
              )}
              <Button
                variant="contained"
                color="primary"
                disabled={running}
                onClick={handleSimulate}
              >
                Simulate
              </Button>
              <Button variant="outlined" component="label">
                Open VCD File
                <input type="file" accept=".vcd" hidden
                  onChange={handleOpenVCDFile} />
              </Button>
              {waveData && !viewerOpen && (
                <Button variant="outlined" color="primary"
                  onClick={() => setViewerOpen(true)}>
                  Reopen Waveforms
                </Button>
              )}
              <span className={classes.status}>
                {running && <CircularProgress size={16}
                  style={{ marginRight: 8 }} />}
                <Typography variant="caption">{statusText}</Typography>
              </span>
            </div>

            <AceEditor
              mode={simulator === 'iverilog' ? 'verilog' : 'vhdl'}
              theme="monokai"
              width="100%"
              height="480px"
              value={code}
              onChange={onCodeChange}
              editorProps={{ $blockScrolling: true }}
              setOptions={{ fontSize: 15, showPrintMargin: false }}
            />
          </Paper>
        </Grid>
      </Grid>

      <Dialog fullScreen open={viewerOpen} onClose={() => setViewerOpen(false)}>
        {waveData && (
          <LogicAnalyzer
            signals={waveData.signals}
            endtime={waveData.endtime}
            timescale={waveData.timescale}
            title={'Logic Analyzer — ' +
              (simulator === 'iverilog' ? 'Icarus Verilog' : 'GHDL')}
            simulator={simulator === 'iverilog' ? 'Icarus Verilog' : 'GHDL'}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </Dialog>
    </Container>
  )
}
