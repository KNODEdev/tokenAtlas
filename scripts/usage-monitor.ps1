param([switch]$Smoke, [switch]$CaptureOnce, [string]$SmokeFixture)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$mutexName = if ($Smoke) { 'Local\tokenAtlas-usage-monitor-smoke' } else { 'Local\tokenAtlas-usage-monitor' }
$script:mutex = New-Object Threading.Mutex($false, $mutexName)
if (-not $script:mutex.WaitOne(0)) { exit }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$tokens = Get-Content -LiteralPath (Join-Path $repo 'src\web\tokens.css') -Raw
$scale = Get-Content -LiteralPath (Join-Path $repo 'src\web\components\ui.css') -Raw
function Brush($name) {
    $value = [regex]::Match($tokens, "--${name}:\s*(#[0-9a-fA-F]+)").Groups[1].Value
    return [Windows.Media.BrushConverter]::new().ConvertFromString($value)
}
function SizeToken($name) {
    return [double][regex]::Match($scale, "--${name}:\s*([0-9.]+)px").Groups[1].Value
}
function Text($value, $size = 'fs-5', $ink = 'text') {
    $label = New-Object Windows.Controls.TextBlock
    $label.Text = $value
    $label.FontSize = SizeToken $size
    $label.Foreground = Brush $ink
    $label.VerticalAlignment = 'Center'
    return $label
}
function AccountGrid {
    $grid = New-Object Windows.Controls.Grid
    foreach ($width in @('*', '8', '58', '8', '58')) {
        $column = New-Object Windows.Controls.ColumnDefinition
        $column.Width = [Windows.GridLengthConverter]::new().ConvertFromString($width)
        $grid.ColumnDefinitions.Add($column)
    }
    return $grid
}
function AddCell($grid, $label, $column, $span = 1) {
    [Windows.Controls.Grid]::SetColumn($label, $column)
    [Windows.Controls.Grid]::SetColumnSpan($label, $span)
    [void]$grid.Children.Add($label)
}
function Divider {
    $rule = New-Object Windows.Controls.Border
    $rule.Height = 1
    $rule.Background = Brush 'line'
    $rule.Margin = New-Object Windows.Thickness(0, (SizeToken 's-6'), 0, (SizeToken 's-6'))
    [void]$panel.Children.Add($rule)
}
function SafeDetail($message) {
    $value = [string]$message
    $value = $value -replace '(?i)(Bearer\s+)\S+', '$1[ukryto]'
    $value = $value -replace '(?i)((?:access_token|refresh_token|id_token)\s*[:=]\s*)\S+', '$1[ukryto]'
    return $value -replace '(?i)[A-Z]:[\\/][^\r\n;]+', '[ścieżka lokalna]'
}
function ErrorLabel($message) {
    if ($message -match 'login-|invalid_grant|sign.in|poświadc|zalogowan|Login zmienił') { return 'Zaloguj ponownie' }
    if ($message -match 'timeout|network|fetch|connect|ENOTFOUND|ECONN|unreachable') { return 'Brak połączenia' }
    if ($message -match '429|rate.limit') { return 'Spróbuję później' }
    return 'Błąd odczytu'
}

$window = New-Object Windows.Window
$window.Title = 'tokenAtlas'
$window.Width = 360
$window.SizeToContent = 'Height'
$window.ResizeMode = 'NoResize'
$window.WindowStyle = 'ToolWindow'
$window.Topmost = $true
$window.Background = Brush 'surface'
$window.Foreground = Brush 'text'
$fontUri = [Uri]((Join-Path $PSScriptRoot 'usage-monitor-assets') + '\')
$window.FontFamily = New-Object Windows.Media.FontFamily($fontUri, './#IBM Plex Sans')
$window.FontSize = SizeToken 'fs-5'
$panel = New-Object Windows.Controls.StackPanel
$panel.Margin = New-Object Windows.Thickness((SizeToken 's-8'), (SizeToken 's-6'), (SizeToken 's-8'), (SizeToken 's-6'))
$window.Content = $panel
$status = New-Object Windows.Controls.StackPanel
$status.Orientation = 'Horizontal'
$script:marker = New-Object Windows.Shapes.Ellipse
$script:marker.Width = SizeToken 's-4'
$script:marker.Height = SizeToken 's-4'
$script:marker.Margin = New-Object Windows.Thickness(0, 0, (SizeToken 's-4'), 0)
$script:marker.Fill = Brush 'accent'
$script:marker.VerticalAlignment = 'Center'
[void]$status.Children.Add($script:marker)
$script:stateLabel = Text 'Uruchamiam odczyty…' 'fs-6'
$script:stateLabel.FontWeight = 'SemiBold'
[void]$status.Children.Add($script:stateLabel)
[void]$panel.Children.Add($status)
$script:nextLabel = Text 'Automatycznie co 20 minut' 'fs-5' 'muted'
$script:nextLabel.Margin = New-Object Windows.Thickness((SizeToken 's-8'), (SizeToken 's-2'), 0, (SizeToken 's-6'))
[void]$panel.Children.Add($script:nextLabel)
$script:groups = @{}
$script:groupHeaders = @{}
foreach ($provider in @('codex', 'claude')) {
    if ($provider -eq 'claude') { Divider }
    $header = AccountGrid
    $header.Height = SizeToken 's-10'
    $name = Text $(if ($provider -eq 'codex') { 'Codex' } else { 'Claude' }) 'fs-6'
    $name.FontWeight = 'SemiBold'
    AddCell $header $name 0
    $short = Text '5 h' 'fs-5' 'muted'
    $short.TextAlignment = 'Right'; AddCell $header $short 2
    $long = Text '7 dni' 'fs-5' 'muted'
    $long.TextAlignment = 'Right'; AddCell $header $long 4
    $script:groupHeaders[$provider] = $long
    [void]$panel.Children.Add($header)
    $rows = New-Object Windows.Controls.StackPanel
    [void]$panel.Children.Add($rows)
    $script:groups[$provider] = $rows
    $placeholder = Text 'Czekam na pierwszy odczyt' 'fs-5' 'muted'
    $placeholder.Height = 28
    [void]$rows.Children.Add($placeholder)
}
Divider
$footer = New-Object Windows.Controls.Grid
$footer.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
$buttonColumn = New-Object Windows.Controls.ColumnDefinition
$buttonColumn.Width = [Windows.GridLength]::Auto
$footer.ColumnDefinitions.Add($buttonColumn)
$script:timeLabel = Text 'Zapis archiwum: —' 'fs-5' 'muted'
AddCell $footer $script:timeLabel 0
$button = New-Object Windows.Controls.Button
$button.Content = 'Zakończ'
$button.MinWidth = 88
$button.Height = 28
$button.Padding = New-Object Windows.Thickness((SizeToken 's-6'), 0, (SizeToken 's-6'), 0)
$button.Background = Brush 'line'
$button.Foreground = Brush 'text'
$button.BorderBrush = Brush 'accent'
$button.Resources.Add('HoverInk', (Brush 'line2'))
$button.Resources.Add('MutedInk', (Brush 'faint'))
$button.Template = [Windows.Markup.XamlReader]::Parse('<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button"><Border x:Name="Sheet" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" /></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Sheet" Property="Background" Value="{DynamicResource HoverInk}" /></Trigger><Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Sheet" Property="BorderThickness" Value="1" /></Trigger><Trigger Property="IsEnabled" Value="False"><Setter Property="Foreground" Value="{DynamicResource MutedInk}" /></Trigger></ControlTemplate.Triggers></ControlTemplate>')
AddCell $footer $button 1
[void]$panel.Children.Add($footer)
$script:process = $null
$script:nextRun = Get-Date
$script:closing = $false
$script:outputTask = $null
$script:errorTask = $null
$script:lastReport = $null
$script:mainCheck = $null
$script:mainCheckOutput = $null
$script:mainKnown = [bool]$Smoke
$script:nextMainCheck = Get-Date
function StartMainCheck {
    if ($Smoke -or $script:mainCheck -or $script:closing) { return }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'usage-monitor-main.ps1') + '" -Check'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $script:mainCheck = [Diagnostics.Process]::Start($info)
    $script:mainCheckOutput = $script:mainCheck.StandardOutput.ReadToEndAsync()
    $script:nextMainCheck = (Get-Date).AddSeconds(5)
}
function MainHandoff {
    $script:closing = $true
    $button.IsEnabled = $false
    $script:stateLabel.Text = 'Główny tokenAtlas przejmuje odczyty'
    $script:stateLabel.FontSize = SizeToken 'fs-5'
    $script:marker.Fill = Brush 'ok'
    $window.Close()
}
function StartCollection {
    if ($script:process -or $script:closing -or -not $script:mainKnown) { return }
    $script:stateLabel.Text = 'Pobieram odczyty…'
    $script:marker.Fill = Brush 'accent'
    $script:nextRun = (Get-Date).AddMinutes(20)
    if ($Smoke) { return }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command bun.exe -ErrorAction Stop).Source
    $info.Arguments = 'run scripts/usage-monitor.ts'
    $info.WorkingDirectory = $repo
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $script:process = [Diagnostics.Process]::Start($info)
    $script:outputTask = $script:process.StandardOutput.ReadToEndAsync()
    $script:errorTask = $script:process.StandardError.ReadToEndAsync()
}
function MeterPeriod($hours) {
    if ($null -eq $hours) { return 'Okno ?' }
    if ($hours % 24 -eq 0) { return ('{0:0.##} dni' -f ([double]$hours / 24)) }
    return ('{0:0.##} h' -f [double]$hours)
}
function ShowReport($report) {
    $script:lastReport = $report
    foreach ($provider in @('codex', 'claude')) {
        $rows = $script:groups[$provider]
        $rows.Children.Clear()
        $accounts = @($report.accounts | Where-Object provider -EQ $provider)
        if (-not $accounts.Count) { [void]$rows.Children.Add((Text 'Brak odczytu' 'fs-5' 'muted')) }
        foreach ($account in $accounts) {
            $row = AccountGrid
            $row.Height = 28
            $label = Text $(if ($account.label) { $account.label } else { 'Brak zalogowanego konta' })
            $label.TextTrimming = 'CharacterEllipsis'
            $label.ToolTip = $label.Text
            AddCell $row $label 0
            if ($account.error) {
                $errorText = Text (ErrorLabel $account.error) 'fs-5' 'warn'
                $errorText.TextAlignment = 'Right'
                $errorText.ToolTip = SafeDetail $account.error
                AddCell $row $errorText 2 3
            } else {
                $meters = @($account.meters | Where-Object { $null -ne $_ })
                $columns = @($meters | Where-Object { $_.accountWide -and $_.hours -in @(5, 168) })
                $others = @($meters | Where-Object { -not $_.accountWide -or $_.hours -notin @(5, 168) })
                if (-not $columns.Count -and $others.Count -eq 1 -and $others[0].accountWide) {
                    $meter = $others[0]
                    $period = MeterPeriod $meter.hours
                    $shown = if ($null -ne $meter.percent) { '{0:0.##}%' -f [double]$meter.percent } else { '—' }
                    $value = Text ($period + ' · ' + $shown) 'fs-6'
                    $value.TextAlignment = 'Right'
                    $value.ToolTip = 'Osobny licznik; nie należy do kolumn 5 h ani 7 dni'
                    AddCell $row $value 2 3
                    $others = @()
                } else {
                    foreach ($hours in @(5, 168)) {
                        $reading = @($columns | Where-Object hours -EQ $hours)
                        $present = $reading.Count -eq 1 -and $null -ne $reading[0].percent
                        $value = Text $(if ($present) { '{0:0.##}%' -f [double]$reading[0].percent } else { '—' }) 'fs-6' $(if ($present) { 'text' } else { 'faint' })
                        $value.TextAlignment = 'Right'
                        [Windows.Documents.Typography]::SetNumeralAlignment($value, 'Tabular')
                        $value.ToolTip = if ($present) { $label.Text } elseif ($reading.Count -gt 1) { 'Dostawca zwrócił kilka różnych liczników tego okna' } else { 'Dostawca nie zwrócił tego okna' }
                        AddCell $row $value $(if ($hours -eq 5) { 2 } else { 4 })
                    }
                    if (@($columns | Where-Object hours -EQ 5).Count -gt 1 -or @($columns | Where-Object hours -EQ 168).Count -gt 1) {
                        $others = @($others) + @($columns)
                    }
                }
            }
            [void]$rows.Children.Add($row)
            if (-not $account.error) {
                foreach ($meter in $others) {
                    $extra = AccountGrid
                    $extra.Height = 28
                    $period = MeterPeriod $meter.hours
                    $scope = if ($meter.scope) { $meter.scope } elseif (-not $meter.accountWide) { $meter.group } else { '' }
                    $name = Text $(if ($scope) { $scope + ' · ' + $period } else { $period }) 'fs-5' 'muted'
                    $name.Margin = New-Object Windows.Thickness((SizeToken 's-4'), 0, 0, 0)
                    $name.TextTrimming = 'CharacterEllipsis'
                    $name.ToolTip = $name.Text
                    AddCell $extra $name 0
                    $value = Text $(if ($null -ne $meter.percent) { '{0:0.##}%' -f [double]$meter.percent } else { '—' }) 'fs-6'
                    $value.TextAlignment = 'Right'
                    AddCell $extra $value $(if ($meter.hours -eq 5) { 2 } else { 4 })
                    [void]$rows.Children.Add($extra)
                }
            }
        }
    }
    $bad = @($report.accounts | Where-Object error)
    $good = @($report.accounts | Where-Object { -not $_.error -and @($_.readings).Count -gt 0 })
    $logins = @($bad | Where-Object { (ErrorLabel $_.error) -eq 'Zaloguj ponownie' })
    if ($report.pending -gt 0) { $script:stateLabel.Text = 'Odczyty czekają na zapis'; $ink = 'warn' }
    elseif ($report.error -or -not $good.Count) { $script:stateLabel.Text = 'Odczyt nie powiódł się'; $ink = 'crit' }
    elseif ($logins.Count) {
        $noun = if ($logins.Count -eq 1) { 'konto' } elseif ($logins.Count -in @(2,3,4)) { 'konta' } else { 'kont' }
        $script:stateLabel.Text = 'Zaloguj ponownie {0} {1}' -f $logins.Count, $noun; $ink = 'warn'
    } elseif ($bad.Count -or @($report.errors).Count) { $script:stateLabel.Text = 'Część odczytów nieudana'; $ink = 'warn' }
    else { $script:stateLabel.Text = 'Zbieranie działa'; $ink = 'ok' }
    $script:marker.Fill = Brush $ink
    $script:stateLabel.ToolTip = SafeDetail ((@($report.errors) + @($report.error)) -join "`n")
    if ($report.delivered -gt 0) {
        $at = ([datetime]$report.at).ToLocalTime()
        $format = if ($at.Date -eq (Get-Date).Date) { 'HH:mm' } else { 'dd.MM HH:mm' }
        $script:timeLabel.Text = 'Zapis archiwum: ' + $at.ToString($format)
    }
}
function UpdateCountdown {
    if ($script:closing) { $script:nextLabel.Text = 'Zamknę po zakończeniu odczytu'; return }
    if ($script:process) { $script:nextLabel.Text = 'Trwa odczyt…'; return }
    $seconds = [Math]::Max(0, [int]($script:nextRun - (Get-Date)).TotalSeconds)
    $script:nextLabel.Text = 'Następny odczyt za ' + [TimeSpan]::FromSeconds($seconds).ToString('mm\:ss')
}
$button.Add_Click({ $window.Close() })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({
    try {
        if ($script:mainCheck -and $script:mainCheck.HasExited -and $script:mainCheckOutput.IsCompleted) {
            $mainOutput = $script:mainCheckOutput.Result
            $mainExitCode = $script:mainCheck.ExitCode
            $script:mainCheck.Dispose(); $script:mainCheck = $null
            try { $mainResult = $mainOutput | ConvertFrom-Json } catch { $mainResult = $null }
            $checkOk = $mainExitCode -eq 0 -and $null -ne $mainResult.running
            $script:mainKnown = $checkOk -and -not $mainResult.running
            if ($checkOk -and $mainResult.running) { MainHandoff; if (-not $script:process) { return } }
            elseif (-not $checkOk) { $script:stateLabel.Text = 'Nie mogę sprawdzić tokenAtlas'; $script:marker.Fill = Brush 'warn' }
        }
        if (-not $Smoke -and -not $script:mainCheck -and (Get-Date) -ge $script:nextMainCheck) { StartMainCheck }
        if ($script:process -and $script:process.HasExited -and $script:outputTask.IsCompleted -and $script:errorTask.IsCompleted) {
            $lines = $script:outputTask.Result.Trim().Split("`n")
            try { $report = $lines[-1] | ConvertFrom-Json; ShowReport $report; if ($report.handoff) { $script:closing = $true } }
            catch { ShowReport ([pscustomobject]@{accounts=@();error='Nie udało się odczytać odpowiedzi kolektora';errors=@()}) }
            $script:process.Dispose(); $script:process = $null
            UpdateCountdown
            if ($CaptureOnce) { SavePreview; $script:CaptureOnce = $false }
            if ($script:closing) { $window.Close(); return }
        }
        if (-not $script:process -and -not $Smoke -and -not $script:closing -and (Get-Date) -ge $script:nextRun) { StartCollection }
        UpdateCountdown
    } catch {
        $script:stateLabel.Text = 'Błąd kolektora'; $script:marker.Fill = Brush 'crit'
        $script:stateLabel.ToolTip = SafeDetail $_.Exception.Message
        $script:nextRun = (Get-Date).AddMinutes(20)
    }
})
function SavePreview {
    $window.UpdateLayout()
    $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.ActualWidth, [int]$window.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($window)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create((Join-Path $repo '.tmp\usage-monitor-smoke.png'))
    $encoder.Save($stream); $stream.Dispose()
    [pscustomobject]@{state=$script:stateLabel.Text;nextRun=$script:nextRun.ToString('o');left=$window.Left;top=$window.Top;width=$window.ActualWidth;height=$window.ActualHeight;visible=$window.IsVisible;button=$button.Content;buttonEnabled=$button.IsEnabled;countdown=$script:nextLabel.Text} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo '.tmp\usage-monitor-ui-proof.json') -Encoding UTF8
}
$window.Add_SizeChanged({
    $area = [Windows.SystemParameters]::WorkArea
    if ($window.IsLoaded) { $window.Top = [Math]::Max($area.Top, [Math]::Min($window.Top, $area.Bottom - $window.ActualHeight - 16)) }
})
$panel.Add_MouseLeftButtonDown({ if ($_.OriginalSource -isnot [Windows.Controls.Button] -and $_.ClickCount -eq 1) { $window.DragMove() } })
$window.Add_Loaded({
    $area = [Windows.SystemParameters]::WorkArea
    $window.Left = $area.Right - $window.ActualWidth - 16
    $window.Top = $area.Bottom - $window.ActualHeight - 16
    if ($Smoke) { StartCollection } else { $script:stateLabel.Text = 'Sprawdzam główny tokenAtlas…'; StartMainCheck }; $timer.Start()
    if ($Smoke) {
        $fixture = if ($SmokeFixture) { $SmokeFixture } else { Join-Path $PSScriptRoot 'usage-monitor-assets\smoke.json' }
        ShowReport (Get-Content -Raw -Encoding UTF8 -LiteralPath $fixture | ConvertFrom-Json)
        UpdateCountdown; SavePreview; $button.RaiseEvent((New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)))
    }
})
$window.Add_Closing({
    if ($script:process) {
        $_.Cancel = $true; $script:closing = $true; $button.IsEnabled = $false
        $script:stateLabel.Text = 'Kończę zapis…'; $script:marker.Fill = Brush 'pencil'
        UpdateCountdown
    }
})
try { [void]$window.ShowDialog() }
finally { $timer.Stop(); if ($script:mainCheck) { if (-not $script:mainCheck.HasExited) { $script:mainCheck.Kill() }; $script:mainCheck.Dispose() }; $script:mutex.ReleaseMutex(); $script:mutex.Dispose() }
