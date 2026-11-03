"""Contain only this invocation's Windows launcher and future descendants.

The host supervises the system-Python PID. A Windows venv switch adds another
PID, so killing only the launcher must not leave a session owner alive. This
module has no account, network, file, process-inventory or recovery interface.
It never finds/kills existing processes by name, PID lists or lock paths.
"""

import ctypes
from ctypes import wintypes
import os
import threading


class BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]


def install_parent_bound_job():
    """Bind the current launcher before it can create a venv child.

    Microsoft documents descendant inheritance and KILL_ON_JOB_CLOSE here:
    https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
    The unnamed, non-inheritable handle stays in this launcher until OS teardown.
    No breakaway/UI/security override is set; incompatible enclosing jobs refuse
    BEFORE provider execution. Windows 8+ supports ordinary nested jobs.
    """
    kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True, winmode=0x800)
    signatures = {
        "GetCurrentProcess": ([], wintypes.HANDLE),
        "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result

    def created(handle):
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise OSError("PROCESS_SCOPE_UNAVAILABLE")
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime

    parent = job = None
    watcher = None
    assigned = False
    stop, arm = threading.Event(), threading.Event()
    try:
        # Bind the real parent kernel object, not a later PID lookup. If that
        # PID was reused before OpenProcess, its creation time is newer than
        # this launcher and admission fails. These rights cannot alter parent.
        parent = kernel.OpenProcess(0x00100000 | 0x1000, False, os.getppid())
        current = kernel.GetCurrentProcess()
        if not parent or created(parent) > created(current) or kernel.WaitForSingleObject(parent, 0) != 258:
            raise OSError("PROCESS_SCOPE_UNAVAILABLE")
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise OSError("PROCESS_SCOPE_UNAVAILABLE")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only.
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise OSError("PROCESS_SCOPE_UNAVAILABLE")

        def watch_parent():
            # Starting before assignment makes thread-creation failure safe:
            # no process belongs to the job and no venv child exists yet.
            arm.wait()
            try:
                while assigned and not stop.is_set():
                    status = kernel.WaitForSingleObject(parent, 250)
                    if status != 258:
                        # Parent death (or loss of the bound wait) ends ONLY
                        # this new job. Closing kills this launcher as well as
                        # its descendants; no Python finally/atexit is required.
                        kernel.CloseHandle(job)
                        return
            finally:
                kernel.CloseHandle(parent)

        watcher = threading.Thread(target=watch_parent, name="telegram-parent-lifetime", daemon=True)
        watcher.start()
        if not kernel.AssignProcessToJobObject(job, current):
            raise OSError("PROCESS_SCOPE_UNAVAILABLE")
        assigned = True
        arm.set()
    except BaseException:
        stop.set()
        arm.set()
        if watcher is not None and watcher.ident is not None:
            watcher.join(1)
        elif parent:
            kernel.CloseHandle(parent)
        if job and not assigned:
            kernel.CloseHandle(job)
        raise

    def finish():
        # Called only after subprocess.run settles. Do NOT close the job here:
        # the launcher itself is a member and must retain the exact child's
        # exit status. Windows closes its sole handle at process termination.
        # The wait thread owns parent-handle cleanup; closing a handle while
        # another thread waits on it would have undefined Win32 behavior.
        stop.set()
        watcher.join(1)

    return finish
