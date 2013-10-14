#!/usr/bin/env ruby

require 'zip/zipfilesystem'
require 'tempfile'
require 'pp'
require 'json'
require 'redcarpet'
require 'nokogiri'
require 'trollop'
require 'net/http'
require 'nokogiri'
require 'rubygems/package'
require 'csv'
require 'stringex'
require 'unicode_utils/downcase'

FORMAT = 'html-json-1'

TIKA = Net::HTTP.new('localhost', 9998)

OPTS = Trollop::options do
  opt :reset, "Re-scan entire library"
end

class Scanner
  EXT = '.offline.html'
  EXT2MIMETYPE = {
    '.epub' => 'application/epub+zip',
    '.mobi' => 'application/x-mobipocket-ebook',
    '.pdf'  => 'application/pdf',
    '.doc'  => 'application/msword',
    '.docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }

  def tika(stream, mimetype, size)
    req = Net::HTTP::Put.new('/all')
    req.body_stream = stream
    req["Content-Type"] = mimetype
    req.add_field('Content-Length', size)
    req.add_field('Accept', 'application/x-tar')
    res = TIKA.request(req)
    
    data = {html: ''}

    tar_extract = Gem::Package::TarReader.new(StringIO.new(res.body))
    tar_extract.rewind
    tar_extract.each do |entry|
      next unless entry.file?
      case entry.full_name
      when '__TEXT__'
        data[:html] = entry.read
      when '__METADATA__'
        data[:metadata] = {}
        CSV.parse(entry.read, :col_sep => ',').each{|row|
          data[:metadata][row[0]] = row[1]
        }
      end
    end
    tar_extract.close

    return data
  end

  def serialize(file, data)
    builder = Nokogiri::HTML::Builder.new(:encoding => 'UTF-8') do |doc|
      doc.html {
        doc.head {
          doc.meta('http-equiv' => 'content-type', 'content' => 'application/xhtml+xml; charset=UTF-8')
        }
        doc.body data.to_json
      }
    end
    File.open(file, "wb", :encoding => 'utf-8'){|f|
      f.write(builder.doc.to_xhtml(:encoding => 'UTF-8'))
    }
  end
  def unserialize(file)
    return JSON.parse(Nokogiri::HTML(File.open(file, 'rb', :encoding => 'utf-8')).at('//body').text)
  end

  def to_ascii(w)
    @toascii ||= {}
    @toascii[w] ||= w.to_ascii.downcase.gsub(/[^a-z]/, '')
    return @toascii[w]
  end

  def text2words(text)
    return text.strip.scan(/[[:alpha:]]{2,}/).collect{|w| w = UnicodeUtils.downcase(w); [w, to_ascii(w)] }.flatten.compact.uniq
  end

  def cachefile(key)
    @cachefile ||= {}
    @cachefile[key] ||= File.join(@root, ".#{key}#{EXT}")
  end

  def initialize(root)
    @root = root
  end

  def reset
    Dir[File.join(@root, ".*#{EXT}")].each{|f| File.unlink(f)}
    File.unlink(File.join(@root, EXT)) if File.exists?(File.join(@root, EXT))
  end

  def index
    @hashes = File.join(@root, EXT)

    hashes = nil
    if File.exists?(@hashes)
      hashes = unserialize(@hashes)
      if hashes['version'] != FORMAT
        reset
        hashes = nil
      end
    end
    hashes ||= {version: FORMAT, hash: {}}
    oldhashes = (hashes[:hash] || {}).dup

    extensions = []
    errors = []
    allwords = []
    Dir[File.join(@root, '*.zip')].sort.each{|zipfile|
      key = File.basename(zipfile, File.extname(zipfile)).upcase

      propfile = File.join(File.dirname(zipfile), File.basename(zipfile, File.extname(zipfile)) + '.prop')
      File.open(propfile){|f| hashes[:hash][key] = Nokogiri::XML(f).xpath('/properties/hash').inner_text }

      next if File.exists?(cachefile(key)) && File.mtime(cachefile(key)) > File.mtime(zipfile) && oldhashes[key] == hashes[:hash][key]

      data = {text: ''}

      File.unlink(cachefile(key)) if File.exists?(cachefile(key))

      puts zipfile
      Zip::ZipFile.foreach(zipfile) {|entry|
        next unless entry.file?

        ext = File.extname(entry.to_s.downcase)

        case ext
        when '.txt'
          data = {text: entry.get_input_stream.read}
        when '.html'
          data[:text] += ' ' + Nokogiri::HTML(entry.get_input_stream.read).inner_text
        when '.epub'
          # Tika doesn't always pick up epub contents
          Tempfile.open('epub') do |f|
            entry.extract(f.path){true}
            Zip::ZipFile.foreach(f.path){|chapter|
              next unless chapter.file?
              next unless chapter.to_s.downcase =~ /\.x?html?$/ || (chapter.to_s.downcase =~ /oebps\/text/ && chapter.to_s.downcase =~ /\.xml$/)
              data[:text] += ' ' +  Nokogiri::HTML(chapter.get_input_stream.read).inner_text
            }
          end
        when '.pdf', '.mobi', '.doc', '.docx'
          raise "No mimetype for #{ext}" unless EXT2MIMETYPE[ext]
          data = tika(entry.get_input_stream, EXT2MIMETYPE[ext], entry.size)
          data[:text] = Nokogiri::HTML(data.delete(:html) || '').inner_text
        else
          extensions << File.extname(entry.to_s.downcase)
        end
      }

      if data[:text].to_s.strip == ''
        errors << zipfile
        next
      end

      data[:chars] = data[:text].length
      data[:words] = text2words(data.delete(:text))
      allwords << data[:words]
      data[:pages] = data[:metadata]['xmpTPg:NPages'] if data[:metadata] && data[:metadata]['xmpTPg:NPages']
      data.delete(:metadata)
      data.delete(:chars) if data[:pages]

      serialize(cachefile(key), data) unless data[:words].empty?
    }

    serialize(@hashes, hashes)
    serialize(File.join(@root, EXT + '.error'), errors)
    serialize(File.join(@root, EXT + '.words'), allwords.flatten.uniq.sort)
  end
end

scanner = Scanner.new('/var/www/webdav/emile/zotero/')

if OPTS[:reset]
  scanner.reset
  exit
end

scanner.index
