const St    = imports.gi.St;
const Meta  = imports.gi.Meta;
const Pango = imports.gi.Pango;


// =====================================================================
// Multi-line Entry
//
// @hint_text        : string
// @scrollable       : bool (make entry use scrollbar or grow indefinitely)
// @single_line_mode : bool (removes any line breaks, still wraps)
// =====================================================================
var MultiLineEntry = class {
    constructor (hint_text, scrollable, single_line_mode) {
        this.scrollable       = scrollable;
        this.single_line_mode = single_line_mode;


        this.entry_vert_padding = -1;
        this.sanitize_flag      = false;
        this.new_text           = '';


        //
        // draw
        //
        this.actor = new St.BoxLayout({ y_expand: true, vertical: true });

        this.entry_container = new St.BoxLayout({ vertical: true });

        if (scrollable) {
            this.scroll_box = new St.ScrollView({ x_fill: true, y_align: St.Align.START, style_class: 'multiline-entry-scrollbox vfade'});
            this.actor.add(this.scroll_box);
            this.scroll_box.add_actor(this.entry_container);
        }
        else {
            this.actor.add_actor(this.entry_container);
        }

        this.entry = new St.Entry({ can_focus: true, hint_text: hint_text, name: 'menu-search-entry' });
        this.entry_container.add_actor(this.entry);

        this.entry.clutter_text.activatable = single_line_mode ? true : false;
        this.entry.clutter_text.single_line_mode = false;
        this.entry.clutter_text.line_wrap        = true;
        this.entry.clutter_text.line_wrap_mode   = Pango.WrapMode.WORD_CHAR;


        //
        // listen
        //
        this.entry.clutter_text.connect('text-changed', () => {
            this._after_text_changed();
        });
        this.entry.clutter_text.connect('key-focus-out', () => {
            this._resize_entry();
        });
        this.entry.clutter_text.connect('key-focus-in', () => {
            this._resize_entry();
        });
        if (single_line_mode) {
            this.entry.clutter_text.connect('insert-text',
                (_, ...args) => this._before_text_changed(...args));
        }
    }

    set_text (text) {
        // @HACK
        // The _resize_entry() func must wait until the actor is drawn, and this
        // is the only way I figured out how to make it work...
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.entry.set_text(text);
        });

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._resize_entry();
        });
    }

    _before_text_changed (added_text, length_of_added_text) {
        // If the text was pasted in (longer than 1 char) or is a newline, set
        // the sanitize flag to true so that after_text_changed cleans the line
        // breaks.
        if (length_of_added_text > 1 || /\r?\n/g.test(added_text)) {
            this.sanitize_flag = true;
            this.new_text = added_text;
        }
    }

    _after_text_changed () {
        // remove line breaks
        if (this.sanitize_flag) {
            let txt = this.entry.get_text();
            this.entry.set_text(txt.replace(/[\r\n]/g, ' '));
            this.sanitize_flag = false;
        }

        this._resize_entry();
    }

    _resize_entry () {
        let theme_node = this.entry.get_theme_node();
        let alloc_box  = this.entry.get_allocation_box();

        // get the actual width of the box
        let width = alloc_box.x2 - alloc_box.x1;

        // removes paddings and borders
        width = theme_node.adjust_for_width(width);

        // nat_height is the minimum height needed to fit the multiline text
        // **excluding** the vertical paddings/borders.
        let [min_height, nat_height] = this.entry.clutter_text.get_preferred_height(width);

        // The vertical padding can only be calculated once the box is painted.
        // nat_height_adjusted is the minimum height needed to fit the multiline
        // text **including** vertical padding/borders.
        if (this.entry_vert_padding < 0) {
            let [, nat_height_adjusted] = theme_node.adjust_preferred_height(min_height, nat_height);
            this.entry_vert_padding = nat_height_adjusted - nat_height;
        }

        this.entry.set_height(nat_height + this.entry_vert_padding);
    }
};
