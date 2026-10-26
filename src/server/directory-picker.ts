let pending: Promise<string | null> | null = null;

/** The dialog opens only after the user presses the directory picker button. */
export function chooseArchiveDirectory(): Promise<string | null> {
  if (pending) return pending;
  if (process.platform !== "win32") return Promise.reject(new Error("The directory picker is available on Windows. Enter the path directly on this system."));
  pending = (async () => {
    const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = 'tokenAtlas — wybierz folder'
$dialog.ShowNewFolderButton = $true
try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath | ConvertTo-Json -Compress } else { 'null' } } finally { $dialog.Dispose() }`;
    const process = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script], {stdout:"pipe",stderr:"pipe"});
    const [code,output,error] = await Promise.all([process.exited,new Response(process.stdout).text(),new Response(process.stderr).text()]);
    if (code !== 0) throw new Error(`Directory selection failed: ${error.trim()}`);
    const value:unknown = JSON.parse(output.replace(/^\uFEFF/,""));
    if (value !== null && typeof value !== "string") throw new Error("Invalid directory selection result");
    return value;
  })().finally(()=>{pending=null;});
  return pending;
}
