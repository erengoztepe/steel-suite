# 🚀 Release Notes: Connection Library Feature

Hi Eren! We've just implemented a massive update to the Member Vectors extraction tool. Here is a detailed breakdown of everything that was added:

## 1. Connection Library (Persistence)

> **2026-07-29 güncellemesi — kalıcılık artık DİSKTE.** Aşağıdaki "localStorage" anlatımı
> ilk sürümü tarif ediyor; geçerli mimari [connection-library-persistence.md](connection-library-persistence.md).
> Özet: kayıtlar `<repo>/.data/connection-library/<ifc>.json` dosyalarında durur; localStorage
> yalnızca ayna/yedek. Ayrıca kayıt anahtarı olan IFC adı artık host'tan (`ifcName` prop'u)
> gelir — eskiden mount anındaki "son açılan IFC" kaydından türetiliyordu, bu yüzden oturum
> içinde ikinci bir dosya yüklenince kayıtlar ÖNCEKİ dosyanın kütüphanesine yazılıyor ve dev
> sunucu yeniden başlatılınca "sıfırlanmış" görünüyordu.

- **Local Storage Integration:** Extracted connection vectors can now be saved! They persist in the browser's localStorage.
- **IFC-Specific:** Saved connections are strictly tied to the IFC file name.

## 2. Interactive Library Panel (UI)
- **Left Sidebar:** A new ConnectionLibraryPanel appears on the left side of the screen.
- **Save Button:** The main results table now has a blue "Save Connection" button.
- **Restore:** Clicking any saved connection in the list instantly restores the exact 3D isolation and the results table.

## 3. "Show All Connections" (Zoom-to-Fit)
- Clicking "Show All Connections" removes isolation, applies a red highlight to every single member across all your saved connections, and automatically zooms the camera to fit them all on your screen.

## 4. Multi-Sheet Excel Export
- **"Export Library to Excel":** Turns the library into an interactive checklist.
- Generates a single .xlsx file where **each selected connection gets its own dedicated Excel Sheet**.

## 5. Renaming & Management
- **Rename:** Hover over any connection and click the pencil icon to rename it.
- **Remove:** Click the trash icon to delete.

## 6. TypeScript Fixes
- Fixed multiple legacy TypeScript errors regarding SimpleWorld, CameraControls, and Highlighter APIs to ensure a 0-error strict build.
